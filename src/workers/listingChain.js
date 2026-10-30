import { randomUUID } from 'node:crypto';
import { DelayedError, UnrecoverableError } from 'bullmq';
import config from '../configs/variables.config.js';
import { getSourceConfig } from '../configs/sources.config.js';
import { getStorage, rawKey } from '../libs/storage/index.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';
import listingNotices from '../repositories/listingNotice.repo.js';
import { ingestFetchQueue } from '../queues/index.js';
import { JOB, PRIORITY } from '../queues/names.js';
import { sha256 } from '../utils/hash.js';
import { withLock, RateLimitedError } from '../utils/rateLimiter.js';
import {
  markSweepHealthy,
  readHighWater,
  advanceHighWater,
  floorKey,
  setFloor,
  raiseFloor,
  chainKey,
  claimChain,
  holdChain,
  releaseChain,
} from '../utils/sweepState.js';
import { endsJob } from '../utils/attempts.js';
import { logger } from '../utils/logger.js';

const { SCRAPER } = config;

/**
 * How long a listing's chain marker outlives the last page that touched it
 * (sweepState.js#chainKey). It has to cover the longest a queued page waits
 * for a worker: measured locally on 2026-10-30, with the worker up and ~48
 * stacked chains swelling the queue, first-attempt waits were p50 15 min,
 * p95 34, max 49. Too short only brings back the duplicate chain this
 * replaces; too long only delays the next chain after one that vanished. A
 * killed worker does not make one vanish — BullMQ hands its active page to
 * the next worker as stalled.
 */
const CHAIN_TTL_MS = 60 * 60 * 1000;

/**
 * The listing chain every board is swept by: fetch a page, store it, turn each
 * notice into a job, and decide whether to read the next page.
 *
 * A board supplies only what differs between sources:
 *
 *   source                 source key; also the sweep lock and freshness key
 *   watermarkKey(slug)     Redis key of the board's high-water mark
 *   markName               what the mark is, for log lines ('tids', 'published')
 *   formatMark(value)      a mark as a log reader wants to see it
 *   read(path, page)       { notModified?, blocksSeen, entries, hasNextPage, response }
 *   markOf(entry)          the entry's watermark value, a number
 *   toNotice(entry, ctx)   { tally?, index?, notice?: { ref, hash, job: { name, data, opts } } }
 *                          — no notice means counted and skipped; `index` is the
 *                          entry's `listing_notices` row, for a board whose
 *                          entries answer "was this code ever published"
 *   summarize(stats)       the source's part of the page log line
 *
 * Whatever a board needs to decide, it decides in those functions; nothing
 * here may branch on a source name.
 */

/**
 * Whether the chain reads another page. Pure, so the one cap rule is in one
 * place.
 *
 * `maxListingPages` bounds a cold start only. With a watermark the chain walks
 * until it reaches it — after an outage that is the gap to re-read — and only
 * the global ceiling stops it. Committing the high mark over pages never read
 * is a permanent, silent coverage hole. The site's own page total is never
 * consulted; whether a next page exists is.
 *
 * A page with no usable marks (`pageLow` Infinity) cannot conclude anything
 * and keeps going, bounded by the cap.
 *
 * Every board is newest-first, so no page holds anything newer than the
 * previous page's oldest mark (`prevLow`). Ties are legal — gnumner's publish
 * times are minute-precision and can straddle a page break. A page that does
 * hold something newer is a pager that did not advance —
 * a malformed page URL the site answers with page 1 does exactly this — and
 * nothing it says about the watermark can be trusted. With a watermark the
 * walk is bounded only by the global ceiling, so such a chain would otherwise
 * re-read one page up to that ceiling every sweep.
 */
export const nextStep = ({ page, since, pageLow, pageHigh, prevLow, hasNextPage, coldStartPages, maxPages }) => {
  if (prevLow !== undefined && pageHigh > prevLow) {
    return { more: false, stalled: true, reachedWatermark: false, reason: 'page did not advance' };
  }
  const cap = since ? maxPages : Math.min(coldStartPages, maxPages);
  if (pageLow <= since) return { more: false, reachedWatermark: true, reason: 'reached the watermark' };
  if (!hasNextPage) return { more: false, reachedWatermark: false, reason: 'no next page' };
  if (page >= cap) return { more: false, reachedWatermark: false, capped: true, reason: `page cap ${cap}` };
  return { more: true, reachedWatermark: false, reason: null };
};

/**
 * A listing's queue priority: live discovery unless its config names another
 * (`priority`, a PRIORITY key) — a listing nothing waits on goes behind the
 * ones that find tenders, on the same rate budget. A name that is not a key
 * throws rather than falling back to live: a typo is not a choice.
 */
const priorityOf = (listing) => {
  if (!listing?.priority) return PRIORITY.LIVE;
  if (!(listing.priority in PRIORITY)) throw new UnrecoverableError(`listing "${listing.slug}": no priority "${listing.priority}"`);
  return PRIORITY[listing.priority];
};

/**
 * The listings one sweep job covers. A listing with a `cron` of its own is
 * swept only by its own schedule (`data.slug`, queues/scheduler.js), never by
 * the source's.
 */
export const listingsToSweep = (listingPaths, slug) =>
  slug ? listingPaths.filter((l) => l.slug === slug) : listingPaths.filter((l) => !l.cron);

/**
 * Enqueue page 1 of every listing the sweep covers. The watermark is read
 * once, here at the top of the chain, so a notice published mid-sweep cannot
 * move the goalposts under the pages still in flight.
 *
 * A listing whose previous chain is still queued or running is skipped: one
 * chain per listing at a time (ticket 38). Skipping is not a failure — the
 * running chain will commit the watermark — so it writes nothing, freshness
 * included.
 */
export const sweepBoard = async (job, board) => {
  const { source } = board;
  const { slug } = job.data;
  const sourceConfig = getSourceConfig(source);
  const log = logger.child({ job: JOB.SOURCE_SWEEP, source, ...(slug ? { slug } : {}) });
  const listings = listingsToSweep(sourceConfig.listingPaths, slug);
  if (slug && !listings.length) throw new UnrecoverableError(`[${source}] no listing "${slug}" to sweep`);

  // A listing on its own schedule has its own lock, so the two never skip each other.
  const busy = [];
  const { skipped } = await withLock(slug ? `sweep:${source}:${slug}` : `sweep:${source}`, 10 * 60 * 1000, async () => {
    for (const listing of listings) {
      const marker = chainKey(board.watermarkKey(listing.slug));
      const chain = randomUUID();
      if (!(await claimChain(marker, chain, CHAIN_TTL_MS))) {
        busy.push(listing.slug);
        log.info(`"${listing.slug}" still has a chain queued or running — not starting another`);
        continue;
      }

      let since;
      try {
        // Read after the claim: the chain that released the marker has already
        // committed its watermark.
        since = await readHighWater(board.watermarkKey(listing.slug));
        await ingestFetchQueue.add(
          JOB.LISTING_PAGE,
          { source, slug: listing.slug, listingPath: listing.path, page: 1, since, chain },
          { priority: priorityOf(listing) }
        );
      } catch (error) {
        await releaseChain(marker, chain);
        throw error;
      }
      log.info(`enqueued page 1 of "${listing.slug}" (since ${since ? board.formatMark(since) : 'never'})`);
    }
  });

  if (skipped) log.warn('previous sweep still running — skipped');
  return { skipped, busy };
};

/**
 * One page of a chain, holding the listing's chain marker while it runs and
 * releasing it when the chain ends: the page committed the watermark, or it
 * threw for the last time. A throw BullMQ will retry, or a rate-limit delay,
 * is the same chain still going.
 *
 * A page with no `chain` was queued before the marker existed and touches
 * none.
 */
export const readListingPage = async (job, token, board) => {
  const { chain, slug } = job.data;
  const marker = chain && chainKey(board.watermarkKey(slug));
  // False when a newer chain took a lapsed marker; this one still runs to its
  // end, it just no longer speaks for the listing.
  if (marker) await holdChain(marker, chain, CHAIN_TTL_MS);

  let outcome;
  try {
    outcome = await readPage(job, token, board);
  } catch (error) {
    if (marker && endsJob(job, error)) await releaseChain(marker, chain);
    throw error;
  }
  // Re-armed once the next page is queued as well, so the TTL has to cover
  // only that page's wait for a worker, not this page's run too.
  if (marker) await (outcome.continued ? holdChain(marker, chain, CHAIN_TTL_MS) : releaseChain(marker, chain));
  return outcome;
};

const readPage = async (job, token, board) => {
  const { source } = board;
  const { slug, listingPath, page, chain } = job.data;
  // `sinceTid`/`highTid` and `sincePublished`/`highPublished` are the names
  // pages queued before the chain was shared carry. Drop them once no such
  // job is left in ingest.fetch.
  const since = job.data.since ?? job.data.sinceTid ?? job.data.sincePublished ?? 0;
  const carriedHigh = job.data.high ?? job.data.highTid ?? job.data.highPublished;
  const prevLow = job.data.low;
  const sourceConfig = getSourceConfig(source);
  const log = logger.child({ job: JOB.LISTING_PAGE, source, slug, page });

  let result;
  try {
    result = await board.read(listingPath, page);
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
    return { notModified: true, continued: false };
  }

  // A "successful" page that ingests nothing is the #1 silent failure.
  if (result.blocksSeen === 0) {
    throw new Error(
      `[${source}] "${slug}" page ${page} returned 200 with 0 blocks — parser likely broken`
    );
  }

  // Page 1 observes the highest mark on the board and carries it down the
  // chain; whichever page terminates the chain commits it as the new
  // watermark.
  const marks = result.entries.map(board.markOf).filter(Number.isFinite);
  const high = carriedHigh ?? (marks.length ? Math.max(...marks) : 0);
  const pageLow = marks.length ? Math.min(...marks) : Infinity;
  const pageHigh = marks.length ? Math.max(...marks) : -Infinity;

  const step = nextStep({
    page,
    since,
    pageLow,
    pageHigh,
    prevLow,
    hasNextPage: result.hasNextPage,
    coldStartPages: sourceConfig.maxListingPages,
    maxPages: SCRAPER.MAX_LISTING_PAGES,
  });

  if (step.stalled) {
    // Thrown before anything is stored, enqueued or marked healthy: the
    // watermark must not be committed, and freshness must not report a
    // source whose every sweep re-reads one page.
    throw new Error(
      `[${source}] "${slug}" page ${page} holds ${board.markName} up to ${board.formatMark(pageHigh)}, ` +
        `newer than page ${page - 1}'s oldest ${board.formatMark(prevLow)} — pager did not advance`
    );
  }

  const storage = await getStorage();
  const pageHash = sha256(result.response.body);
  const pageRef = `listing:${slug}:p${page}`;
  const pageKey = rawKey({ source, ref: pageRef, hash: pageHash, ext: 'html' });

  if (!(await sourcePayloads.existsWithHash(source, pageRef, pageHash))) {
    await storage.put(pageKey, result.response.body, { contentType: 'text/html' });
    await sourcePayloads.record({ source, ref: pageRef, storageKey: pageKey, hash: pageHash });
  }

  const tally = {};
  let changed = 0;

  for (const entry of result.entries) {
    const { tally: bucket, index, notice } = board.toNotice(entry, { slug, log });
    if (bucket) tally[bucket] = (tally[bucket] ?? 0) + 1;
    // Not a domain row: the ingestion's own record of what was published —
    // every entry, ingested or skipped, on every read, so an entry whose
    // notice is unchanged is still recorded once. An upsert, so a re-read is
    // a no-op.
    if (index) await listingNotices.record({ source, ...index });
    if (!notice) continue;

    if (await sourcePayloads.existsWithHash(source, notice.ref, notice.hash)) continue;

    // Discovery only: the listing writes no domain rows.
    //
    // Enqueue BEFORE recording the fingerprint. Recording first meant a crash
    // between the two left the notice marked as seen with no job ever created
    // — the next sweep finds an unchanged hash and skips it forever, a silent
    // permanent coverage hole. This order can only ever duplicate work, and
    // the jobId already dedupes that.
    await ingestFetchQueue.add(notice.job.name, notice.job.data, notice.job.opts);

    // A concurrent worker won the race and already recorded it.
    if (!(await sourcePayloads.record({ source, ref: notice.ref, storageKey: pageKey, hash: notice.hash }))) {
      continue;
    }
    changed += 1;
  }

  await markSweepHealthy(source);

  const range = marks.length ? `${board.formatMark(pageLow)}..${board.formatMark(high)}` : 'none';
  log.info(
    `${board.summarize({ result, tally, changed })}; ${board.markName} ${range} ` +
      `vs watermark ${since ? board.formatMark(since) : 'none'} — ` +
      `${step.more ? `continuing to page ${page + 1}` : `stopping (${step.reason})`}`
  );

  if (!step.more && since && !step.reachedWatermark) {
    // Advancing past an unread gap is the cost of a bounded walk; say so.
    log.warn(
      `chain ended at page ${page} (${step.reason}) without reaching the watermark ` +
        `${board.formatMark(since)}; oldest read ${pageLow === Infinity ? 'none' : board.formatMark(pageLow)} — ` +
        'older notices were not read'
    );
  }

  if (step.more) {
    await ingestFetchQueue.add(
      JOB.LISTING_PAGE,
      {
        source,
        slug,
        listingPath,
        page: page + 1,
        since,
        high,
        low: Number.isFinite(pageLow) ? pageLow : prevLow,
        chain,
      },
      { priority: priorityOf(sourceConfig.listingPaths.find((l) => l.slug === slug)) }
    );
  } else {
    // The floor first (sweepState.js#floorKey): a crash before the watermark
    // moves can only leave the covered window narrower than it is.
    const oldest = Number.isFinite(pageLow) ? pageLow : prevLow;
    if (!since) await setFloor(floorKey(board.watermarkKey(slug)), oldest);
    else if (step.capped) await raiseFloor(floorKey(board.watermarkKey(slug)), oldest);
    await advanceHighWater(board.watermarkKey(slug), high);
  }

  return { entries: result.entries.length, tally, changed, continued: step.more };
};

export default { nextStep, listingsToSweep, sweepBoard, readListingPage };
