import { DelayedError, UnrecoverableError } from 'bullmq';
import { getSourceConfig } from '../configs/sources.config.js';
import { getStorage, rawKey } from '../libs/storage/index.js';
import { fetchProcedureRows } from '../libs/adapters/source/ppcm/client.js';
import { observeProcedures, parseStored, storedPayload } from '../libs/adapters/source/ppcm/observation.js';
import ResultsService from '../services/results.service.js';
import { lookupsFor, resolve } from '../services/resolution.service.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';
import tenders from '../repositories/tender.repo.js';
import tenderSources from '../repositories/tenderSource.repo.js';
import unmatchedResults from '../repositories/unmatchedResult.repo.js';
import { JOB, PRIORITY } from '../queues/names.js';
import { sha256 } from '../utils/hash.js';
import { RateLimitedError } from '../utils/rateLimiter.js';
import { claimPoll } from '../utils/sweepState.js';
import { logger } from '../utils/logger.js';

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
 * One procedure of an answer → its tender's results, or an unmatched result.
 *
 * An e-auction's procedure is left alone: for e-auctions PPCM adds only the
 * bidder's ՀՎՀՀ (ADR 0004, ticket 11) and never a price, rank or status —
 * eauction's own ledger is the authority there.
 */
const recordProcedure = async ({ observation, stored, seenAt, priority, log }) => {
  for (const warning of observation.warnings) log.warn(`${observation.externalId}: ${warning}`);
  if (observation.submissionChannel === 'eauction') return { procedure: observation.externalId, skipped: 'eauction' };

  const decision = resolve(observation, await tenders.findCandidates(lookupsFor(observation)));

  if (decision.action === 'unmatched') {
    await unmatchedResults.record({
      source: SOURCE,
      externalRef: observation.externalId,
      procedureCode: observation.procedureCode,
      // PPCM's own form, so a count of what is unmatched can tell single
      // source from competition (CLAUDE.md, *Single source*).
      procedureType: observation.procedureType,
      reason: decision.reason,
      wasPublic: decision.wasPublic,
      candidateTenderIds: decision.candidateIds,
      payloadHash: stored.hash,
      seenAt,
    });
    log.warn(`procedure ${observation.externalId} unmatched (${decision.reason})`, {
      candidates: decision.candidateIds,
      form: observation.form,
    });
    return { procedure: observation.externalId, unmatched: decision.reason };
  }
  // A result never creates a tender, and PPCM's carries no run of its own
  // to supersede: anything but a link is recorded nowhere and said here.
  if (decision.action !== 'link') {
    log.info(`procedure ${observation.externalId} skipped — ${decision.reason ?? decision.action}`);
    return { procedure: observation.externalId, skipped: decision.reason ?? decision.action };
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
 * corrected) is then attached without waiting for PPCM's rows to change. The
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

  const key = rawKey({ source: SOURCE, ref, hash, ext: 'json' });
  await storage.put(key, text, { contentType: 'application/json; charset=utf-8' });
  const seenAt = new Date();
  const outcome = await recordAnswer({ text, stored: { hash }, seenAt, priority, log });
  await sourcePayloads.record({ source: SOURCE, ref, storageKey: key, hash, fetchedAt: seenAt });

  return { stored: true, rows: fetched.rows.length, ...outcome };
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
 * once per `pollIntervalHours`.
 *
 * PPCM gives a tender no page whose age would say how long ago it was asked
 * about — before it reports one, Tendra holds nothing of it — so each ask is
 * claimed in Redis (`claimPoll`) as the batch is picked, oldest deadline
 * first. The batch rotates through the whole window instead of re-asking its
 * oldest tenders every run. Ids `ppcm-results-…`, the code hashed: a job id
 * may not hold the code's `/`.
 */
export const ppcmRefresher = {
  find: async ({ refreshWindowDays, maxRefreshBatch, pollIntervalHours }) => {
    const owed = await tenders.findAwaitingResults({
      submissionChannel: 'armeps',
      windowDays: refreshWindowDays,
      limit: SCAN_LIMIT,
    });
    const picked = [];
    const codes = new Set();
    for (const tender of owed) {
      if (picked.length === maxRefreshBatch) break;
      const code = askedCode(tender.reference_code);
      if (!code || codes.has(code)) continue;
      codes.add(code);
      if (await claimPoll(`ppcm:asked:${code}`, pollIntervalHours * 60 * 60)) picked.push(tender);
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

export default { handlePpcmResults, ppcmRefresher };
