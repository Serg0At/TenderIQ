import { UnrecoverableError } from 'bullmq';
import { getSourceConfig } from '../configs/sources.config.js';
import { getStorage } from '../libs/storage/index.js';
import * as eauction from '../libs/adapters/source/eauction/observation.js';
import { lookupsFor, resolve, deriveStatus } from '../services/resolution.service.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';
import tenders from '../repositories/tender.repo.js';
import unmatchedResults from '../repositories/unmatchedResult.repo.js';
import { ingestFetchQueue, alertsQueue, maintenanceQueue } from '../queues/index.js';
import { JOB, PRIORITY } from '../queues/names.js';
import { sha256 } from '../utils/hash.js';
import { logger } from '../utils/logger.js';
import { validateNormalizedTender } from '../validations/index.js';

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

/** Source key -> its adapter's payload-to-observation mapper. */
const OBSERVERS = {
  [eauction.SOURCE]: eauction.observeDetail,
};

const readPayload = async (storageKey) => {
  const storage = await getStorage();
  if (!(await storage.head(storageKey))) {
    throw new UnrecoverableError(
      `raw payload is unavailable: "${storageKey}". Restore it in the configured ` +
        'storage backend or re-scrape this notice.'
    );
  }
  const body = await storage.get(storageKey);
  return Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
};

export const normalizeTender = async ({
  source,
  sourceId,
  ref,
  hash,
  storageKey,
  priority = PRIORITY.LIVE,
}) => {
  if (!source || !sourceId || !ref || !hash || !storageKey) {
    throw new UnrecoverableError(
      'normalize.tender requires source, sourceId, ref, hash, and storageKey'
    );
  }
  const observe = OBSERVERS[source];
  if (!observe) {
    throw new UnrecoverableError(`no tender normalizer is registered for source "${source}"`);
  }

  // A newer payload for this ref means this job is describing a page that has
  // already been superseded; normalizing it would walk the tender backwards.
  const latest = await sourcePayloads.findLatestByRef(source, ref);
  if (!latest || latest.hash !== hash) {
    return { event: null, skipped: 'stale_payload' };
  }

  const sourceConfig = getSourceConfig(source);
  // When the page was fetched — a replay re-reads an old page.
  const seenAt = latest.fetched_at;
  const observation = observe(await readPayload(storageKey), {
    externalId: sourceId,
    seenAt,
    baseUrl: sourceConfig.baseUrl,
  });

  const decision = resolve(observation, await tenders.findCandidates(lookupsFor(observation)));

  if (decision.action === 'unmatched') {
    await unmatchedResults.record({
      source,
      externalRef: observation.externalId,
      procedureCode: observation.procedureCode,
      reason: decision.reason,
      candidateTenderIds: decision.candidateIds,
      payloadHash: hash,
      seenAt,
    });
    logger.warn(`[normalizer] ${source}:${sourceId} unmatched (${decision.reason})`, {
      candidates: decision.candidateIds,
    });
    return { event: null, skipped: 'unmatched', reason: decision.reason };
  }

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
    },
    new Date()
  );

  // Degrade, do not discard: an unrecognised label still stores the tender,
  // with a status from its deadline and the label verbatim as source_status.
  // This warning is what prompts adding the label to the adapter properly.
  if (observation.status === null) {
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
  });

  if (result.skipped === 'no_buyer') {
    logger.warn(`[normalizer] ${source}:${sourceId} skipped — no buyer on the detail page`);
    return result;
  }

  // A result that was once unmatched and has now found its tender. Only when
  // the link is new: an observation already linked was never left unmatched
  // since, and the e-auction path skips a pointless UPDATE per page.
  if (decision.rule !== 'link') {
    await unmatchedResults.markResolved({
      source,
      externalRef: observation.externalId,
      tenderId: result.tenderId,
    });
  }

  // Enqueued from here rather than from the detail fetch because this is the
  // point at which the tender is known to exist in the database — the document
  // stage updates it by source_id and would otherwise race its own creation.
  //
  // The jobId is keyed on the invitation URL, NOT on the detail payload hash.
  // A tender walks Հրապարակված → Նախաաճուրդային → Աճուրդ → Շնորհում →
  // Ավարտված, so the detail hash changes about five times and a hash-keyed id
  // would re-download the same unchanged 600 KB archive on every one of them.
  // The content-hash check inside the handler only skips the storage write —
  // by then the request has already been paid for out of the 20/min budget.
  // The seed skips archives unless explicitly opted in — see backfillDocuments.
  const documentsWanted =
    sourceConfig.downloadDocuments &&
    (priority !== PRIORITY.BACKFILL || sourceConfig.backfillDocuments === true);

  if (result.event && tender.invitationUrl && documentsWanted) {
    await ingestFetchQueue.add(
      JOB.TENDER_DOCUMENTS,
      { source, sourceId, invitationUrl: tender.invitationUrl },
      {
        jobId: `${source}-docs-${sourceId}-${sha256(tender.invitationUrl).slice(0, 12)}`,
        priority,
      }
    );
  }

  // The domain event, delivered as a job. Only on a real change, so a
  // re-normalize that moved nothing cannot re-alert anyone.
  if (result.event) {
    await alertsQueue.add(
      JOB.MATCH_TENDER,
      { tenderId: result.tenderId, event: result.event, changedFields: result.changedFields ?? [] },
      {
        // Keyed on the tender's version so each amendment matches exactly once,
        // however many times this job is retried.
        jobId: `match-${result.tenderId}-v${result.version}`,
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
  return result;
};

/** Processor for the ingest.normalize queue. */
export const processIngestNormalize = async (job) => normalizeTender(job.data);

export default { normalizeTender, processIngestNormalize };
