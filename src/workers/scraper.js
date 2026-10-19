import { DelayedError, UnrecoverableError } from 'bullmq';
import config from '../configs/variables.config.js';
import { getSourceConfig } from '../configs/sources.config.js';
import { getStorage, rawKey } from '../libs/storage/index.js';
import { fetchListing, fetchDetail } from '../libs/adapters/source/eauction/client.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';
import tenders from '../repositories/tender.repo.js';
import tenderSources from '../repositories/tenderSource.repo.js';
import { ingestFetchQueue, ingestNormalizeQueue } from '../queues/index.js';
import { JOB, PRIORITY } from '../queues/names.js';
import { sha256, stableHash } from '../utils/hash.js';
import { withLock, RateLimitedError } from '../utils/rateLimiter.js';
import { markSweepHealthy, readHighWater, advanceHighWater } from '../utils/sweepState.js';
import { logger } from '../utils/logger.js';
import { handleTenderDocuments } from './documents.js';
import { handleGnumnerSweep, handleGnumnerListingPage, parkUntilConsumerExists } from './gnumner.js';

const { SCRAPER } = config;

/**
 * Highest tid ingested by a *completed* sweep of this board.
 *
 * This is the pagination depth control. The listing table exposes no publish
 * date (that is a detail-page field), so the previous `publishedAt >= since`
 * rule compared undefined against a date, was therefore always true, and made
 * every sweep walk `maxListingPages` — the exact inversion the design forbids.
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

const handleSweep = async (job) => {
  const { source } = job.data;
  const sourceConfig = getSourceConfig(source);
  const log = logger.child({ job: JOB.SOURCE_SWEEP, source });

  const { skipped } = await withLock(`sweep:${source}`, 10 * 60 * 1000, async () => {
    for (const board of sourceConfig.listingPaths) {
      // Read once, at the top of the chain: every page of this sweep compares
      // against the same watermark, so a notice published mid-sweep cannot
      // move the goalposts underneath the pages still in flight.
      const sinceTid = await readHighWater(tidWatermarkKey(source, board.slug));

      await ingestFetchQueue.add(
        JOB.LISTING_PAGE,
        { source, slug: board.slug, listingPath: board.path, page: 1, sinceTid },
        { priority: PRIORITY.LIVE }
      );
      log.info(`enqueued page 1 of "${board.slug}" (sinceTid ${sinceTid})`);
    }
  });

  if (skipped) log.warn('previous sweep still running — skipped');
  return { skipped };
};

const handleListingPage = async (job, token) => {
  const { source, slug, listingPath, page, sinceTid = 0 } = job.data;
  const sourceConfig = getSourceConfig(source);
  const log = logger.child({ job: JOB.LISTING_PAGE, source, slug, page });

  let result;
  try {
    result = await fetchListing(listingPath, page);
  } catch (error) {
    if (error instanceof RateLimitedError) {
      await job.moveToDelayed(Date.now() + error.retryAfterMs, token);
      throw new DelayedError();
    }
    throw error;
  }

  if (result.notModified) {
    await markSweepHealthy(source);
    log.info('304 not modified — stopping pagination');
    return { notModified: true };
  }

  if (result.blocksSeen === 0) {
    throw new Error(
      `[${source}] "${slug}" page ${page} returned 200 with 0 tender blocks — parser likely broken`
    );
  }

  const skipped = result.skipped ?? { noTid: 0, duplicate: 0 };
  if (skipped.noTid > 0) {
    // Coverage signal: a detail link the parser could not read a tid out of.
    log.info(`skipped ${skipped.noTid}/${result.blocksSeen} rows with no usable tid`);
  }

  const storage = await getStorage();
  const pageHash = sha256(result.response.body);
  const pageRef = `listing:${slug}:p${page}`;
  const pageKey = rawKey({ source, ref: pageRef, hash: pageHash, ext: 'html' });

  if (!(await sourcePayloads.existsWithHash(source, pageRef, pageHash))) {
    await storage.put(pageKey, result.response.body, { contentType: 'text/html' });
    await sourcePayloads.record({ source, ref: pageRef, storageKey: pageKey, hash: pageHash });
  }

  let changed = 0;
  for (const row of result.rows) {
    const ref = `notice:${row.sourceId}`;
    const hash = rowFingerprint(row);

    if (await sourcePayloads.existsWithHash(source, ref, hash)) continue;

    // Discovery only: the listing knows no buyer, no publish date and no
    // prices, so it must not write tenders. Detail is the single writer;
    // listing's job ends at "this one moved".
    //
    // Enqueue BEFORE recording the fingerprint. Recording first meant a crash
    // between the two left the notice marked as seen with no detail job ever
    // created — the next sweep finds an unchanged hash and skips it forever, a
    // silent permanent coverage hole. This order can only ever duplicate work,
    // and the jobId already dedupes that.
    await ingestFetchQueue.add(
      JOB.TENDER_DETAIL,
      { source, sourceId: row.sourceId, listingRef: ref, listingHash: hash },
      { jobId: `${source}-detail-${row.sourceId}-${hash.slice(0, 12)}`, priority: PRIORITY.LIVE }
    );

    // A concurrent worker won the race and already recorded it.
    if (!(await sourcePayloads.record({ source, ref, storageKey: pageKey, hash }))) continue;

    changed += 1;
  }

  await markSweepHealthy(source);

  // Depth control. Page 1 observes the highest tid on the board and carries it
  // down the chain; whichever page terminates the chain commits it as the new
  // watermark. A page whose rows were all unusable yields no tids, so it cannot
  // conclude anything and keeps going — bounded, as always, by maxPage.
  const tids = result.rows.map((row) => Number(row.sourceId)).filter(Number.isFinite);
  const highTid = job.data.highTid ?? (tids.length ? Math.max(...tids) : 0);
  const pageMinTid = tids.length ? Math.min(...tids) : Infinity;

  const maxPage = Math.min(
    result.pagination?.lastPage ?? 1,
    sourceConfig.maxListingPages,
    SCRAPER.MAX_LISTING_PAGES
  );
  const reachedSeen = pageMinTid <= sinceTid;
  const shouldContinue = !reachedSeen && page < maxPage;

  log.info(
    `${result.blocksSeen} blocks, ${result.rows.length} usable, ${changed} new/changed, ` +
      `tids ${pageMinTid}..${highTid} vs watermark ${sinceTid} — ` +
      `${
        shouldContinue
          ? `continuing to page ${page + 1}`
          : `stopping (${reachedSeen ? 'reached already-seen tids' : `page cap ${maxPage}`})`
      }`
  );

  if (shouldContinue) {
    await ingestFetchQueue.add(
      JOB.LISTING_PAGE,
      { source, slug, listingPath, page: page + 1, sinceTid, highTid },
      { priority: PRIORITY.LIVE }
    );
  } else {
    await advanceHighWater(tidWatermarkKey(source, slug), highTid);
  }

  return { rows: result.rows.length, changed, continued: shouldContinue };
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
 * Re-check tenders whose auction has passed but which have not settled.
 *
 * The counterpart to the listing sweep. That one answers "what is new?" by
 * walking the board; this one answers "what has resolved?" by asking the
 * database — the only way to reach a tender that finished long after it fell
 * off the first page.
 *
 * It enqueues plain `tender.detail` jobs, so everything downstream is shared:
 * same rate budget, same content-hash dedupe (an unchanged page costs one
 * request and writes nothing), same normalize path.
 */
const handleRefreshSweep = async (job) => {
  const { source } = job.data;
  const sourceConfig = getSourceConfig(source);
  const log = logger.child({ job: JOB.TENDER_REFRESH, source });

  const stale = await tenders.findNeedingRefresh({
    source,
    windowDays: sourceConfig.refreshWindowDays,
    limit: sourceConfig.maxRefreshBatch,
  });

  if (!stale.length) {
    log.info('nothing awaiting results');
    return { queued: 0 };
  }

  // One re-check per tender per hour at most. Without this, an overlapping run
  // would queue the same tender twice and pay for it out of the rate budget.
  const bucket = Math.floor(Date.now() / (60 * 60 * 1000));
  const prefix = `${source}:`;

  let queued = 0;
  for (const tender of stale) {
    // findNeedingRefresh already constrains source_id to this source's prefix.
    const sourceId = tender.source_id.slice(prefix.length);

    await ingestFetchQueue.add(
      JOB.TENDER_DETAIL,
      { source, sourceId, reason: 'refresh' },
      { jobId: `${source}-refresh-${sourceId}-${bucket}`, priority: PRIORITY.LIVE }
    );
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
 * A sweep and a listing page are the same job for every source; what differs
 * is the parser and the depth rule, so they route on `data.source`.
 */
const LISTING_HANDLERS = {
  eauction: { sweep: handleSweep, listingPage: handleListingPage },
  gnumner: { sweep: handleGnumnerSweep, listingPage: handleGnumnerListingPage },
};

const listingHandlers = (job) => {
  const handlers = LISTING_HANDLERS[job.data?.source];
  if (!handlers) throw new UnrecoverableError(`no listing handlers for source "${job.data?.source}"`);
  return handlers;
};

export const processIngestFetch = async (job, token) => {
  switch (job.name) {
    case JOB.SOURCE_SWEEP:
      return listingHandlers(job).sweep(job);
    case JOB.LISTING_PAGE:
      return listingHandlers(job).listingPage(job, token);
    case JOB.ARMEPS_DETAIL:
    case JOB.PAPER_INVITATION:
      return parkUntilConsumerExists(job, token);
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
