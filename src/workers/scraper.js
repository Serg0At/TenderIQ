import { DelayedError, UnrecoverableError } from 'bullmq';
import { getSourceConfig } from '../configs/sources.config.js';
import { getStorage, rawKey } from '../libs/storage/index.js';
import { fetchListing, fetchDetail } from '../libs/adapters/source/eauction/client.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';
import tenders from '../repositories/tender.repo.js';
import tenderSources from '../repositories/tenderSource.repo.js';
import { ingestFetchQueue, ingestNormalizeQueue } from '../queues/index.js';
import { JOB, PRIORITY } from '../queues/names.js';
import { sha256, stableHash } from '../utils/hash.js';
import { RateLimitedError } from '../utils/rateLimiter.js';
import { logger } from '../utils/logger.js';
import { handleTenderDocuments } from './documents.js';
import { gnumnerBoard } from './gnumner.js';
import { handleArmepsDetail, handleArmepsDocuments, armepsRefresher } from './armeps.js';
import { handlePaperInvitation, handlePaperDocuments, handlePaperAmendment, paperRefresher } from './paper.js';
import { sweepBoard, readListingPage } from './listingChain.js';

/**
 * Highest tid ingested by a *completed* sweep of this board.
 *
 * The e-auction board's watermark for the shared chain (listingChain.js). The
 * listing table exposes no publish date (that is a detail-page field), so the
 * previous `publishedAt >= since` rule compared undefined against a date, was
 * therefore always true, and made every sweep walk `maxListingPages` — the
 * exact inversion the design forbids.
 *
 * tids ascend with publication and the board is sorted newest-first, so
 * "this page's lowest tid is at or below the watermark" is an exact statement
 * that we have already seen everything from here down.
 */
const tidWatermarkKey = (source, slug) => `sweep:tid:${source}:${slug}`;

/**
 * Fields that define "this notice changed".
 *
 * Deliberately excludes the URL: if the source ever changed its URL scheme,
 * every tender in the system would flag as amended at once and re-notify every
 * customer. Title is included, so a buyer rewording the subject does re-alert —
 * the accepted cost of catching material rewordings.
 *
 * `status` is what drives the tender through Հրապարակված → Շնորհում →
 * Ավարտված. Without it here, a tender reaching its auction never looks
 * "changed", is never re-fetched, and its suppliers, bid prices and estimated
 * price — which exist only on a finished tender's detail page — are never
 * ingested at all. `publishedAt` is gone because the listing table has no such
 * column; it was hashing undefined on every row.
 */
const rowFingerprint = (row) =>
  stableHash({
    sourceId: row.sourceId,
    code: row.code,
    title: row.title,
    status: row.status,
    deadlineAt: row.deadlineAt,
  });

/**
 * The e-auction board for the shared listing chain (workers/listingChain.js).
 */
const EAUCTION = 'eauction';

const eauctionBoard = {
  source: EAUCTION,
  watermarkKey: (slug) => tidWatermarkKey(EAUCTION, slug),
  markName: 'tids',
  formatMark: String,

  read: async (listingPath, page) => {
    const result = await fetchListing(listingPath, page);
    return { ...result, entries: result.rows };
  },

  markOf: (row) => Number(row.sourceId),

  // Discovery only: the listing knows no buyer, no publish date and no
  // prices, so it must not write tenders. Detail is the single writer;
  // listing's job ends at "this one moved".
  toNotice: (row) => {
    const ref = `notice:${row.sourceId}`;
    const hash = rowFingerprint(row);
    return {
      notice: {
        ref,
        hash,
        job: {
          name: JOB.TENDER_DETAIL,
          data: { source: EAUCTION, sourceId: row.sourceId, listingRef: ref, listingHash: hash },
          opts: {
            jobId: `${EAUCTION}-detail-${row.sourceId}-${hash.slice(0, 12)}`,
            priority: PRIORITY.LIVE,
          },
        },
      },
    };
  },

  // noTid is a coverage signal: a detail link the parser could not read a tid
  // out of.
  summarize: ({ result, changed }) =>
    `${result.blocksSeen} blocks, ${result.rows.length} usable` +
    `${result.skipped?.noTid ? ` (${result.skipped.noTid} with no usable tid)` : ''}, ` +
    `${changed} new/changed`,
};

/**
 * Fetch one tender's detail page — the only page that carries the buyer, the
 * publish date, and (once finished) the per-lot bid ledger.
 *
 * Stored under ref `detail:{sourceId}`, deliberately NOT the `notice:{sourceId}`
 * the listing uses. Sharing a ref would put two different documents under one
 * identity, and since normalizeTender only proceeds when its payload is still
 * the latest for that ref, each stage would keep invalidating the other's
 * queued job — a silent standoff in which neither ever normalizes.
 */
export const handleTenderDetail = async (job, token) => {
  const { source, sourceId, priority = PRIORITY.LIVE } = job.data;
  const log = logger.child({ job: JOB.TENDER_DETAIL, source, sourceId });

  let result;
  try {
    result = await fetchDetail(sourceId);
  } catch (error) {
    if (error instanceof RateLimitedError) {
      await job.moveToDelayed(Date.now() + error.retryAfterMs, token);
      throw new DelayedError();
    }
    throw error;
  }

  // The page answered and says nothing new, so no normalize job will run —
  // but the source still showed this tender just now, and its link's
  // `last_seen_at` is the record of that. A changed page is recorded by the
  // normalizer instead, together with what it now says.
  if (result.notModified) {
    await tenderSources.touch({ source, externalId: sourceId });
    log.info('304 not modified');
    return { notModified: true };
  }

  const ref = `detail:${sourceId}`;
  const body = result.response.body;
  const hash = sha256(body);

  if (await sourcePayloads.existsWithHash(source, ref, hash)) {
    await tenderSources.touch({ source, externalId: sourceId });
    return { unchanged: true };
  }

  const storage = await getStorage();
  const key = rawKey({ source, ref, hash, ext: 'html' });
  await storage.put(key, body, { contentType: 'text/html' });

  // Lost race — a concurrent worker already recorded this exact page and
  // enqueued its normalize job. Enqueueing a second one is not harmful (the
  // jobId dedupes) but returning early keeps the log honest.
  const inserted = await sourcePayloads.record({ source, ref, storageKey: key, hash });
  if (!inserted) return { unchanged: true };

  // Priority is carried through from whoever asked for this detail page, so a
  // seed-originated normalize never queues ahead of a live one.
  await ingestNormalizeQueue.add(
    JOB.NORMALIZE_TENDER,
    { source, sourceId, ref, hash, storageKey: key, priority },
    { jobId: `${source}-normalize-${sourceId}-${hash.slice(0, 12)}`, priority }
  );

  log.info('detail stored, normalize enqueued', { storageKey: key });
  return { stored: true, storageKey: key };
};

/**
 * The e-auction refresh: tenders whose auction has passed but which have not
 * settled, re-read as plain `tender.detail` jobs.
 */
const eauctionRefresher = {
  find: ({ refreshWindowDays, maxRefreshBatch }) =>
    tenders.findNeedingRefresh({ source: EAUCTION, windowDays: refreshWindowDays, limit: maxRefreshBatch }),
  job: (tender, bucket) => {
    // The tender's current link, never its creating `source_id`: after an
    // amendment that is a dead run (ticket 29).
    const sourceId = tender.external_id;
    return {
      name: JOB.TENDER_DETAIL,
      data: { source: EAUCTION, sourceId, reason: 'refresh' },
      opts: { jobId: `${EAUCTION}-refresh-${sourceId}-${bucket}`, priority: PRIORITY.LIVE },
    };
  },
};

/**
 * Per source: which tenders the refresh re-reads, and the job that does it.
 * The questions differ — e-auction asks "what has resolved?" after the
 * auction, armeps.am "what has moved?" before the deadline, and paper "what
 * has closed?", since its file never changes — and the rest is shared.
 */
const REFRESHERS = {
  eauction: eauctionRefresher,
  armeps: armepsRefresher,
  gnumner: paperRefresher,
};

/**
 * Re-check a source's unsettled tenders.
 *
 * The counterpart to the listing sweep. That one answers "what is new?" by
 * walking the board; this one asks the database — the only way to reach a
 * tender that changed long after it fell off the first page, or one whose
 * source has no listing at all.
 *
 * It enqueues the source's ordinary detail jobs, so everything downstream is
 * shared: same rate budget, same content-hash dedupe (an unchanged page costs
 * one request and writes nothing), same normalize path.
 */
const handleRefreshSweep = async (job) => {
  const { source } = job.data;
  const refresher = REFRESHERS[source];
  if (!refresher) throw new UnrecoverableError(`no refresh for source "${source}"`);
  const sourceConfig = getSourceConfig(source);
  const log = logger.child({ job: JOB.TENDER_REFRESH, source });

  const stale = await refresher.find(sourceConfig);

  if (!stale.length) {
    log.info('nothing to re-check');
    return { queued: 0 };
  }

  // One re-check per tender per hour at most. Without this, an overlapping run
  // would queue the same tender twice and pay for it out of the rate budget.
  const bucket = Math.floor(Date.now() / (60 * 60 * 1000));

  let queued = 0;
  for (const tender of stale) {
    const { name, data, opts } = refresher.job(tender, bucket);
    await ingestFetchQueue.add(name, data, opts);
    queued += 1;
  }

  // Reported so a backlog is visible: consistently hitting the cap means the
  // batch size is too small for the volume of unsettled tenders.
  const capped = stale.length === sourceConfig.maxRefreshBatch;
  log.info(
    `queued ${queued} re-checks${capped ? ` (batch cap ${sourceConfig.maxRefreshBatch} reached)` : ''}`
  );

  return { queued, capped };
};

/**
 * Processor for the ingest.fetch queue.
 *
 * A sweep and a listing page are the same chain for every source; what
 * differs is the board, so they route on `data.source`.
 */
const BOARDS = {
  eauction: eauctionBoard,
  gnumner: gnumnerBoard,
};

const boardFor = (job) => {
  const board = BOARDS[job.data?.source];
  if (!board) throw new UnrecoverableError(`no listing board for source "${job.data?.source}"`);
  return board;
};

export const processIngestFetch = async (job, token) => {
  switch (job.name) {
    case JOB.SOURCE_SWEEP:
      return sweepBoard(job, boardFor(job));
    case JOB.LISTING_PAGE:
      return readListingPage(job, token, boardFor(job));
    case JOB.ARMEPS_DETAIL:
      return handleArmepsDetail(job, token);
    case JOB.ARMEPS_DOCUMENTS:
      return handleArmepsDocuments(job, token);
    case JOB.PAPER_INVITATION:
      return handlePaperInvitation(job, token);
    case JOB.PAPER_DOCUMENTS:
      return handlePaperDocuments(job);
    case JOB.PAPER_AMENDMENT:
      return handlePaperAmendment(job, token);
    case JOB.TENDER_DETAIL:
      return handleTenderDetail(job, token);
    case JOB.TENDER_DOCUMENTS:
      return handleTenderDocuments(job, token);
    case JOB.TENDER_REFRESH:
      return handleRefreshSweep(job);
    default:
      throw new UnrecoverableError(`unknown job "${job.name}" on ingest.fetch`);
  }
};

export default { processIngestFetch };
