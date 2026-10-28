import { UnrecoverableError } from 'bullmq';
import { getSourceConfig } from '../configs/sources.config.js';
import { getStorage } from '../libs/storage/index.js';
import * as eauction from '../libs/adapters/source/eauction/observation.js';
import * as armeps from '../libs/adapters/source/armeps/observation.js';
import * as gnumner from '../libs/adapters/source/gnumner/observation.js';
import { lookupsFor, resolve, deriveStatus } from '../services/resolution.service.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';
import tenders from '../repositories/tender.repo.js';
import tenderSources, { SUPERSEDED } from '../repositories/tenderSource.repo.js';
import unmatchedResults from '../repositories/unmatchedResult.repo.js';
import { ingestFetchQueue, alertsQueue, maintenanceQueue } from '../queues/index.js';
import { JOB, PRIORITY, matchJobId } from '../queues/names.js';
import { logger } from '../utils/logger.js';
import { validateNormalizedTender } from '../validations/index.js';
import { eauctionDocumentsJob } from './documents.js';
import { armepsDocumentsJob } from './armeps.js';
import { paperDocumentsJob, queueResultRetries } from './paper.js';
import { queuePpcmRetries } from './ppcm.js';
import { linkDiscovery, linkPaperDiscovery } from '../services/discoveryLink.service.js';
import { noticesFor } from '../services/paperNotice.service.js';

/**
 * Source payload -> domain entities. The only stage that writes tenders,
 * parties, awards and bids.
 *
 * It runs on its own queue so a mapping bug can be fixed and replayed straight
 * from object storage without re-crawling the source — which is also why this
 * file re-parses the stored payload rather than trusting anything the fetch job
 * put in the job payload.
 *
 * A thin orchestrator: the source's adapter turns the payload into an
 * observation, services/resolution.service.js decides which tender it belongs
 * to and what status that tender is in, and the repositories write. Nothing
 * here knows what a source's pages look like, and no merge rule lives here.
 */

/**
 * Source key -> its adapter's payload-to-observation mapper, the document
 * stage's job for a saved tender (null for none), how the notice that
 * discovered it is linked once it exists, and what a tender owes its source
 * when it gains a file — created, or joined by a re-post. The only per-source table here; what each entry does
 * lives with its source.
 *
 * gnumner's payload is a paper invitation: binary, and saying nothing about
 * when it was published, which its deadline is counted from. `context` reads
 * the notices that listed it — from the job on a first run, from storage on
 * a replay (services/paperNotice.service.js). A paper tender, once created or
 * joined by a re-posted file, takes any contract or failure notice already
 * read for its code (tickets 08, 09): the new file's publication may be the
 * date it states. An ARMEPS tender, once created, takes any failure notice
 * read before it (ticket 09), and an ARMEPS or e-auction tender any PPCM
 * procedure left unmatched under its code (ticket 12) — the tender a missed
 * PPCM result repaired among them.
 */
const SOURCES = {
  [eauction.SOURCE]: {
    observe: eauction.observeDetail,
    documentsJob: eauctionDocumentsJob,
    newFile: ({ tenderId, version, tender, priority }) =>
      queuePpcmRetries({ tenderId, version, referenceCode: tender.referenceCode, priority }),
  },
  [armeps.SOURCE]: {
    observe: armeps.observeDetail,
    documentsJob: armepsDocumentsJob,
    link: ({ discovery, observation }) =>
      linkDiscovery({ discovery, pointer: { source: armeps.SOURCE, externalId: observation.externalId } }),
    newFile: async ({ tenderId, version, tender, priority }) => {
      await queueResultRetries({ tenderId, version, referenceCode: tender.referenceCode, priority });
      await queuePpcmRetries({ tenderId, version, referenceCode: tender.referenceCode, priority });
    },
  },
  [gnumner.SOURCE]: {
    observe: gnumner.observeInvitation,
    documentsJob: paperDocumentsJob,
    binary: true,
    context: async ({ sourceId, discovery }) => ({ notices: await noticesFor({ invitationId: sourceId, discovery }) }),
    link: ({ discovery, observation }) => linkPaperDiscovery({ discovery, invitationId: observation.externalId }),
    newFile: ({ tenderId, version, tender, priority }) =>
      queueResultRetries({ tenderId, version, referenceCode: tender.referenceCode, priority }),
  },
};

const readPayload = async (storageKey, { binary = false } = {}) => {
  const storage = await getStorage();
  if (!(await storage.head(storageKey))) {
    throw new UnrecoverableError(
      `raw payload is unavailable: "${storageKey}". Restore it in the configured ` +
        'storage backend or re-scrape this notice.'
    );
  }
  const body = await storage.get(storageKey);
  if (binary) return Buffer.isBuffer(body) ? body : Buffer.from(body);
  return Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
};

export const normalizeTender = async ({
  source,
  sourceId,
  ref,
  hash,
  storageKey,
  priority = PRIORITY.LIVE,
  // The gnumner notice that led to this page, if one did. It is not in the
  // stored payload, so a replay has none, and needs none: the link it writes
  // is kept from the first run (and a paper invitation reads its notices back
  // through those links).
  discovery = null,
  // Set by the detail fetch on the first normalize of a newly stored page;
  // absent on a replay or a refresh re-normalize. See armepsDocumentsJob.
  fresh = false,
}) => {
  if (!source || !sourceId || !ref || !hash || !storageKey) {
    throw new UnrecoverableError(
      'normalize.tender requires source, sourceId, ref, hash, and storageKey'
    );
  }
  const registered = SOURCES[source];
  if (!registered) {
    throw new UnrecoverableError(`no tender normalizer is registered for source "${source}"`);
  }
  const { observe, documentsJob, binary = false, context = null, link = null, newFile = null } = registered;

  // A newer payload for this ref means this job is describing a page that has
  // already been superseded; normalizing it would walk the tender backwards.
  const latest = await sourcePayloads.findLatestByRef(source, ref);
  if (!latest || latest.hash !== hash) {
    return { event: null, skipped: 'stale_payload' };
  }

  const sourceConfig = getSourceConfig(source);
  // When the page was fetched — a replay re-reads an old page.
  const seenAt = latest.fetched_at;
  const observation = observe(await readPayload(storageKey, { binary }), {
    externalId: sourceId,
    seenAt,
    baseUrl: sourceConfig.baseUrl,
    ...(context ? await context({ sourceId, discovery }) : {}),
  });

  // What the adapter found worth saying about its own reading (a paper
  // deadline taken from the listing, say). It decides nothing here.
  for (const warning of observation.warnings ?? []) logger.warn(`[normalizer] ${source}:${sourceId} — ${warning}`);

  const lookups = lookupsFor(observation);
  const candidates = await tenders.findCandidates(lookups);
  const decision = resolve(observation, candidates);

  if (decision.action === 'unmatched') {
    await unmatchedResults.record({
      source,
      externalRef: observation.externalId,
      procedureCode: observation.procedureCode,
      procedureType: observation.procedureType,
      reason: decision.reason,
      candidateTenderIds: decision.candidateIds,
      payloadHash: hash,
      seenAt,
    });
    logger.warn(`[normalizer] ${source}:${sourceId} unmatched (${decision.reason})`, {
      candidates: decision.candidateIds,
      ...(observation.unreadable ? { format: observation.unreadable.format } : {}),
    });
    return { event: null, skipped: 'unmatched', reason: decision.reason };
  }

  // A replaced run nothing links to: its replacement records it when it
  // arrives, which the sweep sees within minutes as a new tid (ticket 29).
  if (decision.action === 'skip') {
    logger.info(`[normalizer] ${source}:${sourceId} skipped — ${decision.reason}, no tender links it yet`);
    return { event: null, skipped: decision.reason };
  }

  // A dead run's page writes its own link and nothing else: the tender keeps
  // its status until the replacement joins, and its fields are the
  // replacement's to set. A superseded link is never refreshed again. An
  // older paper file read after the one that replaced it (ticket 07) is one
  // too, and its notice is still a notice of the tender.
  if (decision.action === 'superseded') {
    await tenderSources.upsert({
      tenderId: decision.tenderId,
      source,
      externalId: observation.externalId,
      url: observation.url,
      role: observation.role,
      observedStatus: SUPERSEDED,
      seenAt,
    });
    if (discovery && link) await link({ discovery, observation });
    logger.info(`[normalizer] ${source}:${sourceId} is a superseded run of tender ${decision.tenderId}`);
    return { event: null, tenderId: decision.tenderId, superseded: true };
  }

  // This page has just joined the tender of a run it replaced: an e-auction
  // amendment's new tid (ticket 29), or a re-posted paper invitation (ticket 07).
  const replaces = decision.rule === 'supersedes' || decision.rule === 'reposts';

  // Only this observation's status is passed: every tender today has one link.
  // A second source's link stores its label verbatim, so deriving across links
  // needs each label mapped by its own adapter first — the work of the ticket
  // that adds that source.
  const status = deriveStatus(
    {
      submissionChannel: observation.submissionChannel,
      links: [{ source, status: observation.status }],
      current: decision.tender?.status ?? null,
      deadlineAt: observation.deadlineAt,
      replaces,
    },
    new Date()
  );

  // Degrade, do not discard: an unrecognised label still stores the tender,
  // with a status from its deadline and the label verbatim as source_status.
  // This warning is what prompts adding the label to the adapter properly.
  // A page that states no status at all (armeps.am) has nothing to map.
  if (observation.status === null && observation.observedStatus !== null) {
    logger.warn(
      `[normalizer] unmapped ${source} status ${JSON.stringify(observation.observedStatus)} on tender ` +
        `${sourceId} — stored as "${status}" from its deadline. Add it to the ${source} adapter's ` +
        'status map'
    );
  }

  const tender = validateNormalizedTender({ ...observation.tender, status });

  const result = await tenders.saveNormalized({
    source,
    sourceId: `${source}:${observation.externalId}`,
    tenderId: decision.tenderId ?? null,
    buyerName: observation.buyerName,
    buyerTaxId: observation.buyerTaxId ?? null,
    tender,
    lots: observation.ledger,
    link: {
      source,
      externalId: observation.externalId,
      url: observation.url,
      role: observation.role,
      observedStatus: observation.observedStatus,
      seenAt,
    },
    supersedes: observation.supersedes ?? [],
    replaces,
    // A re-post names nothing it replaced; the tender's current file is it.
    supersedeCurrent: decision.rule === 'reposts',
    // A paper file created as a new run: the runs resolution saw, so a
    // concurrent create of the same code is caught under the row's lock.
    runGuard:
      decision.action === 'create' && lookups.codeRuns
        ? { ...lookups.codeRuns, knownIds: candidates.codeRuns.map((c) => c.id) }
        : null,
  });

  if (result.skipped === 'no_buyer') {
    logger.warn(`[normalizer] ${source}:${sourceId} skipped — no buyer on the detail page`);
    return result;
  }

  // A tender created with something unresolved beside it, recorded after the
  // save so a page with no buyer leaves no row pointing at a tender never
  // written: a replacement whose predecessors are on two tenders, created as a
  // new run with the two tenders left exactly as they were (ticket 29, an
  // `ambiguous` row) — and a paper re-post that could join two runs, the
  // same way (ticket 07); or a tender with no readable code, which no result can
  // ever be matched to (ticket 06, `no_code`).
  if (decision.unmatched) {
    await unmatchedResults.record({
      source,
      externalRef: observation.externalId,
      procedureCode: observation.procedureCode,
      procedureType: observation.procedureType,
      reason: decision.unmatched.reason,
      candidateTenderIds: decision.unmatched.candidateIds,
      payloadHash: hash,
      seenAt,
    });
    logger.warn(`[normalizer] ${source}:${sourceId} created, and recorded as ${decision.unmatched.reason}`, {
      tenderId: result.tenderId,
      candidates: decision.unmatched.candidateIds,
    });
  } else if (decision.rule !== 'link') {
    // A result that was once unmatched and has now found its tender. Only when
    // the link is new: an observation already linked was never left unmatched
    // since, and the e-auction path skips a pointless UPDATE per page.
    await unmatchedResults.markResolved({
      source,
      externalRef: observation.externalId,
      tenderId: result.tenderId,
    });
  }

  // The notice that discovered this page, now that its tender exists. Which
  // tender is again the resolution module's call, through the pointer.
  if (discovery && link) await link({ discovery, observation });

  // A result read before its tender existed, or before the file it names
  // joined: now there is a run to take it.
  if (newFile && (result.event === 'TenderIngested' || (replaces && result.event))) {
    await newFile({ tenderId: result.tenderId, version: result.version, tender, priority });
  }

  // Enqueued from here rather than from the detail fetch because this is the
  // point at which the tender is known to exist in the database — the document
  // stage updates it by source_id and would otherwise race its own creation.
  // When, and under which job id, is the source's call (its `documentsJob`).
  // The seed skips archives unless explicitly opted in — see backfillDocuments.
  const documentsWanted =
    sourceConfig.downloadDocuments &&
    (priority !== PRIORITY.BACKFILL || sourceConfig.backfillDocuments === true);

  const documents = documentsWanted ? documentsJob(observation, { sourceId, result, fresh, priority }) : null;

  // A join is one amendment, and it names both what moved and which files the
  // replacement's archive changed. The files are only known once that archive
  // is stored, so the alert travels with the document job, which raises it
  // whatever becomes of the download. With no document job, it goes now.
  const amendment =
    replaces && result.event === 'TenderAmended'
      ? { tenderId: result.tenderId, version: result.version, changedFields: result.changedFields ?? [] }
      : null;

  if (documents) {
    await ingestFetchQueue.add(
      documents.name,
      amendment ? { ...documents.data, amendment } : documents.data,
      documents.opts
    );
  }

  // The domain event, delivered as a job. Only on a real change, so a
  // re-normalize that moved nothing cannot re-alert anyone.
  if (result.event && !(amendment && documents)) {
    await alertsQueue.add(
      JOB.MATCH_TENDER,
      { tenderId: result.tenderId, event: result.event, version: result.version, changedFields: result.changedFields ?? [] },
      {
        // Keyed on the tender's version so each amendment matches exactly once,
        // however many times this job is retried.
        jobId: matchJobId(result.tenderId, result.version),
        priority,
      }
    );
  }

  // A settled tender changes what "similar tenders won at" means for its
  // categories, so its benchmarks are refreshed. Only when awards actually
  // landed — an active tender with no ledger moves no prices.
  if (result.event && (result.awards ?? 0) > 0) {
    await maintenanceQueue.add(
      JOB.RECOMPUTE_BENCHMARKS,
      { tenderId: result.tenderId },
      { jobId: `benchmarks-${result.tenderId}-v${result.version}`, priority }
    );
  }

  if (result.event) logger.info(`[normalizer] ${result.event}`, { sourceId, ...result });
  // Reported where it is made, as at the document stage (ticket 19).
  if (result.buyersRefused) {
    logger.warn(
      `[buyers] ${source}:${sourceId}: ՀՎՀՀ ${observation.buyerTaxId} is held by buyers whose names differ — ` +
        'not merged (npm run buyers:merge -- --confirm): ' +
        result.buyersRefused.map((b) => `${b.source_id} «${b.name}»`).join(', ')
    );
  }
  return result;
};

/** Processor for the ingest.normalize queue. */
export const processIngestNormalize = async (job) => normalizeTender(job.data);

export default { normalizeTender, processIngestNormalize };
