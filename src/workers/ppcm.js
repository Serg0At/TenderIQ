import { DelayedError, UnrecoverableError } from 'bullmq';
import { getSourceConfig } from '../configs/sources.config.js';
import { getStorage, rawKey } from '../libs/storage/index.js';
import { fetchBidReportTenders, fetchDayRows, fetchProcedureRows, RefusedError } from '../libs/adapters/source/ppcm/client.js';
import {
  cftOf,
  observeDay,
  observeProcedures,
  parseBidReport,
  parseStored,
  storedBidReport,
  storedDayPayload,
  storedPayload,
} from '../libs/adapters/source/ppcm/observation.js';
import BidderTaxIdService from '../services/bidderTaxId.service.js';
import ResultsService from '../services/results.service.js';
import { lookupsFor, normalizeCode, resolve, wasPublic } from '../services/resolution.service.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';
import tenders from '../repositories/tender.repo.js';
import tenderSources from '../repositories/tenderSource.repo.js';
import unmatchedResults from '../repositories/unmatchedResult.repo.js';
import { ingestFetchQueue } from '../queues/index.js';
import { JOB, PRIORITY } from '../queues/names.js';
import { sha256 } from '../utils/hash.js';
import { RateLimitedError } from '../utils/rateLimiter.js';
import { claimPoll } from '../utils/sweepState.js';
import { logger } from '../utils/logger.js';
import { publicityOf } from './paper.js';

/**
 * PPCM: the bidders, prices and winner of every ARMEPS tender (ticket 10).
 *
 * A tender is asked about by its procedure code, once it is past its deadline
 * and until every lot of it is awarded or failed, or it is cancelled
 * (`ppcmRefresher`, `tenders.findAwaitingResults`). The answer is
 * stored whole, as received; each procedure in it is resolved like any result
 * — our code, the ARMEPS channel, the announcement and opening dates — and
 * written through `ResultsService`, the path a gnumner contract notice takes
 * for a paper tender. A procedure PPCM has not reported yet is simply absent
 * from the answer: nothing is written, the tender stays unresolved, and a bid
 * on it stays `not_found` and retryable.
 *
 * An e-auction is asked about too, once awarded and while a bidder of its
 * ledger has no ՀՎՀՀ (`tenders.findAwaitingTaxIds`), and gains only that
 * (ticket 11, `recordTaxIds`).
 *
 * The missed-tender sweep (ticket 12, `handlePpcmSweepDay`) reads the same
 * report by announcement day instead of by code, and resolves every procedure
 * in it the same way — so a procedure Tendra has no tender for is found, not
 * only the ones it asked about. Such a procedure is a `no_candidate`
 * unmatched result carrying `was_public` (ticket 31): `true` is a tender
 * Tendra missed, and is what a later operator alert reads; `false` and `null`
 * are not. An ARMEPS one asks bid-report for its armeps.am page and fetches
 * it, and once the tender exists the procedure is asked about again by code
 * and attaches (`queuePpcmRetries`).
 */
const SOURCE = 'ppcm';

/**
 * A code as PPCM is asked for it: exactly as the tender states it, trimmed.
 * PPCM's filter is exact and case-sensitive, so another spelling of a code is
 * another question with another answer, and is asked and stored as its own.
 */
const askedCode = (code) => String(code ?? '').trim();

/**
 * The stored answer for one code: every run of the code in one answer, so two
 * tenders Tendra holds under one code are asked about once.
 */
const resultsRef = (code) => `results:${askedCode(code)}`;

/**
 * Where an answer is stored: under a digest of its code, not the code. The
 * key URL-encodes its ref, an Armenian letter is six characters there, and
 * `source_payloads.storage_key` holds 255 — «ՀՀ ԱԱԾ-ՏՆՏՎ-ԷԱՃԱՊՁԲ-26/31-
 * ԱՎՏՈՄԵՔԵՆԱ4» did not fit (ticket 11). Still one key per code and content,
 * so a retried write is an overwrite; `ref` keeps the code readable.
 */
const resultsKeyRef = (code) => `results-${sha256(askedCode(code)).slice(0, 32)}`;

/** An unmatched procedure, recorded under its procedure id (`{code}@{announced}`) — re-seen, the same row. */
const recordUnmatched = ({ observation, decision, isPublic, stored, seenAt }) =>
  unmatchedResults.record({
    source: SOURCE,
    externalRef: observation.externalId,
    procedureCode: observation.procedureCode,
    // PPCM's own form, so a count of what is unmatched can tell single
    // source from competition (CLAUDE.md, *Single source*).
    procedureType: observation.procedureType,
    reason: decision.reason,
    wasPublic: isPublic,
    candidateTenderIds: decision.candidateIds,
    payloadHash: stored.hash,
    seenAt,
  });

/**
 * An e-auction's procedure → its bidders' ՀՎՀՀ, and nothing else (ADR 0004,
 * ticket 11): no link, no bid, no award, no status — eauction's own ledger is
 * the authority on all of those. The tender is resolution's, exactly as for
 * ARMEPS (rule 3: code, the eauction channel, announcement and opening days).
 *
 * One Tendra holds no tender for, or two, is an unmatched result like an
 * ARMEPS one (ticket 12), with no repair: nothing maps an e-auction's code to
 * its tid. One that attaches resolves its unmatched row, if it had one.
 */
const recordTaxIds = async ({ observation, decision, stored, seenAt, log }) => {
  const procedure = observation.externalId;
  if (decision.action === 'unmatched') {
    await recordUnmatched({ observation, decision, isPublic: decision.wasPublic, stored, seenAt });
    log.info(`e-auction procedure ${procedure} unmatched (${decision.reason})`, { candidates: decision.candidateIds });
    return { procedure, channel: 'eauction', unmatched: decision.reason, wasPublic: decision.wasPublic };
  }
  if (decision.action !== 'link') {
    const reason = decision.reason ?? decision.action;
    log.info(`e-auction procedure ${procedure} not attached — ${reason}`);
    return { procedure, channel: 'eauction', skipped: reason };
  }

  const result = await BidderTaxIdService.attach({ observation, tenderId: decision.tenderId });
  await unmatchedResults.markResolved({ source: SOURCE, externalRef: procedure, tenderId: decision.tenderId });
  for (const { taxId, partyIds } of result.shared) {
    log.warn(`ՀՎՀՀ ${taxId} is held by ${partyIds.length} parties — reported, not merged`, { partyIds });
  }
  const missed = Object.entries(result.unmatched).filter(([, n]) => n > 0);
  log.info(
    `e-auction procedure ${procedure}: ${result.attached} parties gained a ՀՎՀՀ, ${result.already} already held it` +
      (missed.length ? `, not attached: ${missed.map(([why, n]) => `${n} ${why}`).join(', ')}` : ''),
    { tenderId: decision.tenderId }
  );
  return { procedure, channel: 'eauction', tenderId: decision.tenderId, ...result };
};

/** bid-report's stored answers, one ref per code, as for the report's (`resultsRef`). */
const bidReportRef = (code) => `bid-report:${askedCode(code)}`;
const bidReportKeyRef = (code) => `bid-report-${sha256(askedCode(code)).slice(0, 32)}`;

/**
 * Queue the armeps.am page of a missed procedure, at most once per
 * `repairPollHours` per page (`ppcm:page:{resourceId}`): a procedure still
 * unmatched once its page has made a tender (rule 3's dates disagree) must not
 * fetch that page every day of the window, and a fetch that failed is tried
 * again once its claim lapses — the id carries the hour, since a finished job
 * keeps its id. Returns whether it was queued.
 */
const queueRepairPage = async (resourceId, priority) => {
  const { repairPollHours } = getSourceConfig(SOURCE).bidReport;
  if (!(await claimPoll(`ppcm:page:${resourceId}`, repairPollHours * 60 * 60))) return false;
  await ingestFetchQueue.add(
    JOB.ARMEPS_DETAIL,
    { source: 'armeps', resourceId: String(resourceId), priority },
    { jobId: `armeps-repair-${resourceId}-${Math.floor(Date.now() / (60 * 60 * 1000))}`, priority }
  );
  return true;
};

/**
 * What the stored bid-report answer of a procedure's code says about it
 * (`cftOf`), or null when bid-report has not been asked. Storage only.
 */
const storedCft = async (observation) => {
  const stored = await sourcePayloads.findLatestByRef(SOURCE, bidReportRef(observation.procedureCode));
  if (!stored) return null;
  const text = Buffer.from(await (await getStorage()).get(stored.storage_key)).toString('utf8');
  return cftOf(parseBidReport(text).tenders, observation);
};

/**
 * A `no_candidate` ARMEPS procedure → its repair (ADR 0004: *it repairs
 * itself where it can*), or what stands in the way.
 *
 * `cft` is what bid-report's stored answer for the code says (`storedCft`):
 * an armeps.am page it names, not paper-based, is queued (`armeps.detail`,
 * ticket 05's job). The
 * page makes the tender; the normalizer then asks PPCM about the code again
 * (`queuePpcmRetries`) and the procedure attaches. With no page in the
 * stored answer, or none stored, bid-report is asked again (`ppcm.repair`)
 * at most once per `repairPollHours` per code — claimed here, so 90 days of
 * a broken endpoint cost one ask a day, not one per procedure per day.
 */
const repairGap = async ({ observation, cft, priority }) => {
  if (cft?.resourceId) {
    return { outcome: (await queueRepairPage(cft.resourceId, priority)) ? 'page_queued' : 'page_asked_recently' };
  }
  const code = askedCode(observation.procedureCode);
  const { repairPollHours } = getSourceConfig(SOURCE).bidReport;
  if (!(await claimPoll(`ppcm:cft:${code}`, repairPollHours * 60 * 60))) return { outcome: cft?.none ?? 'asked_recently' };
  await ingestFetchQueue.add(
    JOB.PPCM_REPAIR,
    {
      source: SOURCE,
      code,
      procedure: observation.externalId,
      announcedAt: observation.publishedAt?.toISOString() ?? null,
      openingAt: observation.deadlineAt?.toISOString() ?? null,
    },
    { jobId: `${SOURCE}-repair-${sha256(code).slice(0, 16)}-${Math.floor(Date.now() / (60 * 60 * 1000))}`, priority }
  );
  return { outcome: 'asked' };
};

/**
 * Ask bid-report for one code's armeps.am pages (ticket 12), store the answer
 * whole, and queue the page of the procedure the sweep asked for — matched by
 * its opening day (`cftOf`), which the job carries with its announcement —
 * marking it public now rather than at the next sweep. Another procedure of
 * the code finds the stored answer on its own next read (`repairGap`).
 *
 * bid-report refusing (`{"status":500}`, all research.md ever got from it)
 * completes the job: the procedure stays `no_candidate` and counted, and the
 * code is asked again once its claim lapses. Throttled is delayed, never
 * failed; no answer at all is retried like any fetch.
 */
export const handlePpcmRepair = async (job, token) => {
  const { procedure = null, announcedAt = null, openingAt = null } = job.data;
  const code = askedCode(job.data.code);
  const date = (iso) => (iso ? new Date(iso) : null);
  const dated = [announcedAt, openingAt].every((iso) => iso === null || Number.isFinite(date(iso)?.getTime()));
  if (typeof job.data.code !== 'string' || !code || typeof procedure !== 'string' || !dated) {
    throw new UnrecoverableError(`ppcm.repair needs a procedure code, id and ISO dates, got ${JSON.stringify(job.data)}`);
  }
  const priority = job.opts?.priority ?? PRIORITY.RESULTS;
  const log = logger.child({ job: JOB.PPCM_REPAIR, source: SOURCE, code, procedure });

  let answer;
  try {
    answer = await fetchBidReportTenders(code);
  } catch (error) {
    if (error instanceof RateLimitedError) {
      await job.moveToDelayed(Date.now() + error.retryAfterMs, token);
      throw new DelayedError();
    }
    if (error instanceof RefusedError) {
      log.warn(`bid-report unavailable: ${error.message} — the procedure stays no_candidate`);
      return { unavailable: true };
    }
    throw error;
  }

  const text = storedBidReport({ code, body: answer.body });
  const hash = sha256(text);
  if (!(await sourcePayloads.existsWithHash(SOURCE, bidReportRef(code), hash))) {
    const key = rawKey({ source: SOURCE, ref: bidReportKeyRef(code), hash, ext: 'json' });
    await (await getStorage()).put(key, text, { contentType: 'application/json; charset=utf-8' });
    await sourcePayloads.record({ source: SOURCE, ref: bidReportRef(code), storageKey: key, hash });
  }

  const cft = cftOf(answer.tenders, { procedureCode: code, publishedAt: date(announcedAt), deadlineAt: date(openingAt) });
  if (!cft.resourceId) {
    log.info(`no armeps.am page to fetch — ${cft.none}`);
    return { tenders: answer.tenders.length, [cft.none]: 1 };
  }
  await unmatchedResults.markPublic({ source: SOURCE, externalRef: procedure });
  const queued = await queueRepairPage(cft.resourceId, priority);
  log.info(`missed, armeps.am ${cft.resourceId} ${queued ? 'queued' : 'asked about recently'}`);
  return { tenders: answer.tenders.length, [queued ? 'page_queued' : 'page_asked_recently']: 1, resourceId: cft.resourceId };
};

/** Worth asking bid-report about: a competitive ARMEPS-form procedure with a code and no tender. */
const repairable = (observation, decision) =>
  decision.reason === 'no_candidate' &&
  observation.submissionChannel === 'armeps' &&
  observation.procedureType !== 'single_source' &&
  Boolean(askedCode(observation.procedureCode));

/**
 * One procedure of an answer → its tender's results, or an unmatched result.
 *
 * Resolved with ticket 31's publicity facts — gnumner's invitation listings
 * and the window they cover — so an unmatched one carries `was_public`.
 * `repair` lets a `no_candidate` ARMEPS procedure be repaired (`repairGap`):
 * the sweep's, never an ask by code's — that code is a tender Tendra holds. `onlyUnlinked`
 * passes over a procedure already linked to its tender: an unchanged answer
 * has nothing new to write there (an e-auction is never linked, and is
 * matched again — which writes nothing unless a ՀՎՀՀ is still blank).
 */
const recordProcedure = async ({ observation, stored, seenAt, priority, log, repair = false, onlyUnlinked = false }) => {
  for (const warning of observation.warnings) log.warn(`${observation.externalId}: ${warning}`);

  const publicity = await publicityOf(observation);
  const decision = resolve(observation, { ...(await tenders.findCandidates(lookupsFor(observation))), publicity });
  if (observation.submissionChannel === 'eauction') return recordTaxIds({ observation, decision, stored, seenAt, log });

  if (decision.action === 'unmatched') {
    // bid-report's stored answer is a fact on every read, an ask by code's
    // included — or that ask would write `was_public` back to what gnumner
    // alone says until the next sweep. Only the sweep repairs.
    const cft = repairable(observation, decision) ? await storedCft(observation) : null;
    const fix = repair && repairable(observation, decision) ? await repairGap({ observation, cft, priority }) : null;
    const isPublic = cft?.resourceId ? wasPublic(observation, { ...publicity, armepsPage: true }) : decision.wasPublic;
    await recordUnmatched({ observation, decision, isPublic, stored, seenAt });
    log.warn(`procedure ${observation.externalId} unmatched (${decision.reason}, was_public ${isPublic})`, {
      candidates: decision.candidateIds,
      form: observation.form,
    });
    return {
      procedure: observation.externalId,
      unmatched: decision.reason,
      wasPublic: isPublic,
      ...(fix ? { repair: fix.outcome } : {}),
    };
  }
  // A result never creates a tender, and PPCM's carries no run of its own
  // to supersede: anything but a link is recorded nowhere and said here — a
  // code Tendra holds only on paper or e-auction is that tender's
  // (`other_channel`), not a missed ARMEPS one.
  if (decision.action !== 'link') {
    log.info(`procedure ${observation.externalId} skipped — ${decision.reason ?? decision.action}`);
    return { procedure: observation.externalId, skipped: decision.reason ?? decision.action };
  }
  if (onlyUnlinked && decision.rule === 'link') {
    return { procedure: observation.externalId, tenderId: decision.tenderId, unchanged: true };
  }

  // PPCM is the ARMEPS channel's award source (ADR 0004). A tender PPCM
  // reports bids for but no winner keeps the status its deadline gives it.
  const result = await ResultsService.record({
    observation,
    decision,
    link: {
      source: SOURCE,
      externalId: observation.externalId,
      url: observation.url,
      role: observation.role,
      observedStatus: null,
      seenAt,
    },
    benchmarkKey: `${SOURCE}-${stored.hash.slice(0, 12)}`,
    priority,
  });
  log.info(
    `procedure ${observation.externalId}: ${result.bids} bids, ${result.awards} awards, tender ${result.status}`,
    { tenderId: decision.tenderId }
  );
  return {
    procedure: observation.externalId,
    tenderId: decision.tenderId,
    status: result.status,
    bids: result.bids,
    awards: result.awards,
    ...(result.event ? { version: result.version } : {}),
  };
};

/** One stored answer → every procedure in it, recorded. Reads storage and the database only. */
const recordAnswer = async ({ text, stored, seenAt, priority, log }) => {
  const { columns } = getSourceConfig(SOURCE).organizedProcedures;
  const observations = observeProcedures(parseStored(text, { columns }));
  const procedures = [];
  for (const observation of observations) {
    procedures.push(await recordProcedure({ observation, stored, seenAt, priority, log }));
  }
  if (!observations.length) log.info('not reported yet');
  return { procedures };
};

/**
 * Ask PPCM about one procedure code and record what it says.
 *
 * An answer identical to one stored before writes nothing: it was recorded
 * when it was first seen — unless the tender asked about still holds no PPCM
 * link, when the answer is resolved again from memory. A procedure left
 * unmatched because its tender did not fit yet (not stored, its dates since
 * corrected) is then attached without waiting for PPCM's rows to change. An
 * e-auction never holds a PPCM link, so its answer is always matched again —
 * which writes nothing unless a bidder's ՀՎՀՀ is still blank. The
 * payload row is written last, after every procedure in it is, so an ask that
 * fails part-way leaves no record and the next one reads the same answer again
 * instead of calling it unchanged.
 *
 * `reason: 'replay'` records the latest stored answer again, with no request
 * — for a parser that improved.
 */
export const handlePpcmResults = async (job, token) => {
  const { tenderId = null } = job.data;
  const code = askedCode(job.data.code);
  if (typeof job.data.code !== 'string' || !code) {
    throw new UnrecoverableError(`ppcm.results needs a procedure code, got ${JSON.stringify(job.data.code)}`);
  }
  const priority = job.opts?.priority ?? PRIORITY.RESULTS;
  const ref = resultsRef(code);
  const log = logger.child({ job: JOB.PPCM_RESULTS, source: SOURCE, code, ...(tenderId ? { tenderId } : {}) });
  const storage = await getStorage();

  if (job.data.reason === 'replay') {
    const stored = await sourcePayloads.findLatestByRef(SOURCE, ref);
    if (!stored) throw new UnrecoverableError(`[${SOURCE}] no stored answer for ${code}`);
    const text = Buffer.from(await storage.get(stored.storage_key)).toString('utf8');
    return recordAnswer({ text, stored, seenAt: stored.fetched_at, priority, log });
  }

  let fetched;
  try {
    fetched = await fetchProcedureRows(code);
  } catch (error) {
    // Throttled is not failed: it must not spend an attempt.
    if (error instanceof RateLimitedError) {
      await job.moveToDelayed(Date.now() + error.retryAfterMs, token);
      throw new DelayedError();
    }
    throw error;
  }

  const { reportId } = getSourceConfig(SOURCE).organizedProcedures;
  const text = storedPayload({ reportId, code, bodies: fetched.bodies });
  const hash = sha256(text);
  if (await sourcePayloads.existsWithHash(SOURCE, ref, hash)) {
    const linked = !tenderId || (await tenderSources.listForTender(tenderId)).some((link) => link.source === SOURCE);
    if (linked) return { unchanged: true, rows: fetched.rows.length };
    const outcome = await recordAnswer({ text, stored: { hash }, seenAt: new Date(), priority, log });
    return { unchanged: true, resolvedAgain: true, rows: fetched.rows.length, ...outcome };
  }

  const key = rawKey({ source: SOURCE, ref: resultsKeyRef(code), hash, ext: 'json' });
  await storage.put(key, text, { contentType: 'application/json; charset=utf-8' });
  const seenAt = new Date();
  const outcome = await recordAnswer({ text, stored: { hash }, seenAt, priority, log });
  await sourcePayloads.record({ source: SOURCE, ref, storageKey: key, hash, fetchedAt: seenAt });

  return { stored: true, rows: fetched.rows.length, ...outcome };
};

/** A UTC calendar day, `YYYY-MM-DD`, `daysBack` before `now`. */
const dayBefore = (now, daysBack) => new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A form's part of a job id: its name hashed, since a job id is best kept ASCII. */
const formTag = (form) => sha256(form).slice(0, 8);

/**
 * The missed-tender sweep (ticket 12), scheduled daily (`missed-ppcm`): one
 * `ppcm.sweep.day` per swept form and announcement day, today and the
 * `windowDays` before it. No request is made here.
 *
 * Every day of the window every day, because PPCM fills a day in as buyers
 * file — weeks late, or never — and an unchanged day costs one request and
 * writes nothing. Ids carry the run's day, so a second run on one day queues
 * nothing new.
 */
export const handlePpcmSweep = async () => {
  const { windowDays, forms } = getSourceConfig(SOURCE).missedSweep;
  const now = new Date();
  const run = dayBefore(now, 0);
  const jobs = [];
  for (let back = 0; back <= windowDays; back += 1) {
    const day = dayBefore(now, back);
    for (const form of forms) {
      jobs.push({
        name: JOB.PPCM_SWEEP_DAY,
        data: { source: SOURCE, form, day },
        opts: { jobId: `${SOURCE}-sweep-${formTag(form)}-${day}-${run}`, priority: PRIORITY.RESULTS },
      });
    }
  }
  await ingestFetchQueue.addBulk(jobs);
  logger.info(`[${SOURCE}] missed-tender sweep: ${jobs.length} days queued (${forms.length} forms, ${windowDays + 1} days)`);
  return { queued: jobs.length };
};

/** The stored answer of one sweep query. */
const dayRef = (form, day) => `sweep:${day}:${form}`;
const dayKeyRef = (form, day) => `sweep-${day}-${formTag(form)}`;

/**
 * One sweep answer's outcomes → the counts its log line and job result carry.
 * `misses` is the operator alert's row: `no_candidate` and `was_public` true.
 */
const tally = (outcomes, uncoded) => {
  const count = (pick) =>
    outcomes.reduce((acc, outcome) => {
      const key = pick(outcome);
      if (key !== undefined && key !== null) acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
  return {
    procedures: outcomes.length,
    linked: outcomes.filter((o) => o.tenderId).length,
    // A linked e-auction's `unmatched` is its ՀՎՀՀ counts, not a reason.
    unmatched: count((o) => (o.tenderId ? null : o.unmatched)),
    misses: outcomes.filter((o) => o.unmatched === 'no_candidate' && o.wasPublic === true).length,
    wasPublic: count((o) => (o.unmatched === 'no_candidate' ? String(o.wasPublic) : null)),
    skipped: count((o) => o.skipped),
    repairs: count((o) => o.repair),
    uncoded,
  };
};

/**
 * One form's procedures announced on one day: read, stored, and every one of
 * them resolved (`recordProcedure`, the per-code ask's own path) — a tender's
 * results, an e-auction's ՀՎՀՀ, or an unmatched result, which for an ARMEPS
 * procedure asks bid-report for its page.
 *
 * An unchanged answer writes nothing it wrote before: only the procedures not
 * linked yet are resolved again — a tender may have appeared, the covered
 * window grown, bid-report come back — and `last_seen_at` moves. The payload
 * row is written last, after every procedure, as for an answer by code.
 */
export const handlePpcmSweepDay = async (job, token) => {
  const { form, day } = job.data;
  const { forms } = getSourceConfig(SOURCE).missedSweep;
  if (!forms.includes(form) || !DAY.test(String(day ?? ''))) {
    throw new UnrecoverableError(`ppcm.sweep.day needs a swept form and a YYYY-MM-DD day, got ${JSON.stringify({ form, day })}`);
  }
  const priority = job.opts?.priority ?? PRIORITY.RESULTS;
  const log = logger.child({ job: JOB.PPCM_SWEEP_DAY, source: SOURCE, form, day });

  let fetched;
  try {
    fetched = await fetchDayRows({ form, day });
  } catch (error) {
    if (error instanceof RateLimitedError) {
      await job.moveToDelayed(Date.now() + error.retryAfterMs, token);
      throw new DelayedError();
    }
    throw error;
  }

  const { reportId, columns } = getSourceConfig(SOURCE).organizedProcedures;
  const text = storedDayPayload({ reportId, form, day, bodies: fetched.bodies });
  const hash = sha256(text);
  const ref = dayRef(form, day);
  const unchanged = await sourcePayloads.existsWithHash(SOURCE, ref, hash);
  const seenAt = new Date();

  const key = unchanged ? null : rawKey({ source: SOURCE, ref: dayKeyRef(form, day), hash, ext: 'json' });
  if (key) await (await getStorage()).put(key, text, { contentType: 'application/json; charset=utf-8' });

  const { observations, uncoded } = observeDay({ ...parseStored(text, { columns }), reportId });
  if (uncoded) log.warn(`${uncoded} rows name no procedure code — not read`);
  const outcomes = [];
  for (const observation of observations) {
    outcomes.push(
      await recordProcedure({ observation, stored: { hash }, seenAt, priority, log, repair: true, onlyUnlinked: unchanged })
    );
  }

  if (key) await sourcePayloads.record({ source: SOURCE, ref, storageKey: key, hash, fetchedAt: seenAt });
  const counts = tally(outcomes, uncoded);
  if (counts.procedures) {
    log.info(
      `${counts.procedures} procedures: ${counts.linked} linked, ${counts.misses} missed` +
        (Object.keys(counts.unmatched).length ? `, unmatched ${JSON.stringify(counts.unmatched)}` : '') +
        (Object.keys(counts.repairs).length ? `, repairs ${JSON.stringify(counts.repairs)}` : '')
    );
  }
  return { ...(unchanged ? { unchanged: true } : { stored: true }), rows: fetched.rows.length, ...counts };
};

/**
 * A tender has just been created under a code (normalizer.js, ARMEPS and
 * e-auction): every PPCM procedure left unmatched under that code is asked
 * about again — once per spelling PPCM used, since its code filter is exact —
 * and attaches when exactly one candidate now fits ("a result that arrives
 * before its tender attaches once the tender is found"). It is the tender a
 * repair fetched, or one discovered late. One request per spelling, at the
 * results priority: the answer may well be unchanged, and then it is
 * resolved again from memory because the tender holds no PPCM link.
 */
export const queuePpcmRetries = async ({ tenderId, version, referenceCode, priority = PRIORITY.RESULTS }) => {
  const key = normalizeCode(referenceCode);
  if (!key) return 0;
  const open = await unmatchedResults.findOpenByCode({ source: SOURCE, refPrefix: '', key });
  const codes = [...new Set(open.map((row) => askedCode(row.procedure_code)).filter(Boolean))];
  const lowest = Math.max(priority, PRIORITY.RESULTS);
  for (const code of codes) {
    await ingestFetchQueue.add(
      JOB.PPCM_RESULTS,
      { source: SOURCE, tenderId, code },
      { jobId: `${SOURCE}-retry-${sha256(code).slice(0, 16)}-${tenderId}-v${version}`, priority: lowest }
    );
  }
  if (codes.length) logger.info(`[${SOURCE}] tender ${tenderId} (${referenceCode}): asking PPCM again for ${open.length} unmatched procedures`);
  return codes.length;
};

/**
 * A ceiling on the tenders the refresh looks through for its batch. The
 * window bounds the set; this only stops a backlog from becoming one
 * unbounded query.
 */
const SCAN_LIMIT = 5000;

/**
 * The PPCM refresh, for scraper.js#handleRefreshSweep: ARMEPS tenders past
 * their deadline whose results are still owed, each code asked about at most
 * once per `pollIntervalHours`, and then — in whatever room the batch has
 * left — awarded e-auctions with a bidder still lacking a ՀՎՀՀ, each at most
 * once per `taxIdPollHours` (ticket 11). Results come first: a ՀՎՀՀ is never
 * time-critical, and an e-auction backlog must not hold back an ARMEPS award.
 *
 * PPCM gives a tender no page whose age would say how long ago it was asked
 * about — before it reports one, Tendra holds nothing of it — so each ask is
 * claimed in Redis (`claimPoll`) as the batch is picked, oldest deadline
 * first. The batch rotates through the whole window instead of re-asking its
 * oldest tenders every run. Ids `ppcm-results-…`, the code hashed: a job id
 * may not hold the code's `/`.
 */
export const ppcmRefresher = {
  find: async ({ refreshWindowDays, maxRefreshBatch, pollIntervalHours, taxIdPollHours }) => {
    const picked = [];
    const codes = new Set();
    const pick = async (owed, hours) => {
      for (const tender of owed) {
        if (picked.length === maxRefreshBatch) return;
        const code = askedCode(tender.reference_code);
        if (!code || codes.has(code)) continue;
        codes.add(code);
        if (await claimPoll(`ppcm:asked:${code}`, hours * 60 * 60)) picked.push(tender);
      }
    };
    await pick(
      await tenders.findAwaitingResults({ submissionChannel: 'armeps', windowDays: refreshWindowDays, limit: SCAN_LIMIT }),
      pollIntervalHours
    );
    if (picked.length < maxRefreshBatch) {
      await pick(await tenders.findAwaitingTaxIds({ windowDays: refreshWindowDays, limit: SCAN_LIMIT }), taxIdPollHours);
    }
    return picked;
  },
  job: (tender, bucket) => ({
    name: JOB.PPCM_RESULTS,
    data: { source: SOURCE, tenderId: tender.id, code: tender.reference_code },
    opts: {
      jobId: `${SOURCE}-results-${sha256(askedCode(tender.reference_code)).slice(0, 16)}-${bucket}`,
      priority: PRIORITY.RESULTS,
    },
  }),
};

export default { handlePpcmResults, handlePpcmSweep, handlePpcmSweepDay, handlePpcmRepair, queuePpcmRetries, ppcmRefresher };
