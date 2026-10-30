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
 * p95 34, max 49. Later pages now jump that queue (`PRIORITY.CHAIN`), but
 * page 1 still waits at its listing's priority. Too short only brings back
 * the duplicate chain this replaces; too long only delays the next chain
 * after one that vanished. A killed worker does not make one vanish — BullMQ
 * hands its active page to the next worker as stalled.
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
 *   keyOf(entry)           the entry's identity on the board, a string — what
 *                          tells two entries of one mark apart
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
 * A page that holds nothing the chain has not already read (`unread` 0) is a
 * pager that did not advance — a malformed page URL the site answers with
 * page 1 does exactly this — and nothing it says about the watermark can be
 * trusted. With a watermark the walk is bounded only by the global ceiling,
 * so such a chain would otherwise re-read one page up to that ceiling every
 * sweep. A page that merely repeats some of the previous page is not one:
 * rows published while the chain walked pushed the board down (`isRead`).
 */
export const nextStep = ({ page, since, pageLow, unread, prevLow, hasNextPage, coldStartPages, maxPages }) => {
  if (prevLow !== undefined && Number.isFinite(pageLow) && unread === 0) {
    return { more: false, stalled: true, reachedWatermark: false, reason: 'page did not advance' };
  }
  const cap = since ? maxPages : Math.min(coldStartPages, maxPages);
  if (pageLow <= since) return { more: false, reachedWatermark: true, reason: 'reached the watermark' };
  if (!hasNextPage) return { more: false, reachedWatermark: false, reason: 'no next page' };
  if (page >= cap) return { more: false, reachedWatermark: false, capped: true, reason: `page cap ${cap}` };
  return { more: true, reachedWatermark: false, reason: null };
};

/**
 * A listing's page-1 priority, which decides when its chain starts — the
 * pages after it all go at `PRIORITY.CHAIN`: live discovery unless its config
 * names another (`priority`, a PRIORITY key) — a listing nothing waits on goes
 * behind the ones that find tenders, on the same rate budget. A name that is not a key
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

/**
 * Whether the chain has already read an entry. Every board is newest-first and
 * the chain walks down it, so an entry newer than the oldest mark read so far
 * (`low`) was read on an earlier page — or was published after page 1, and is
 * the next chain's: its mark is at or above the watermark this one commits,
 * and a chain reads the whole of every page it reaches. At `low` itself marks tie (gnumner's publish times are minute-precision and
 * can straddle a page break), so only the entries named in `lowKeys` were.
 */
export const isRead = (mark, key, { low, lowKeys }) =>
  low !== undefined && (mark > low || (mark === low && lowKeys.includes(key)));

/** One request for a listing page; being throttled delays the job, never fails it. */
const fetchListingPage = async (job, token, board, page) => {
  const { source } = board;
  const { slug, listingPath } = job.data;
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
  // A "successful" page that ingests nothing is the #1 silent failure.
  if (!result.notModified && result.blocksSeen === 0) {
    throw new Error(
      `[${source}] "${slug}" page ${page} returned 200 with 0 blocks — parser likely broken`
    );
  }
  return result;
};

/** Stores a listing page as fetched, and returns its key. */
const storeListingPage = async (board, slug, page, result) => {
  const { source } = board;
  const pageHash = sha256(result.response.body);
  const pageRef = `listing:${slug}:p${page}`;
  const pageKey = rawKey({ source, ref: pageRef, hash: pageHash, ext: 'html' });
  if (!(await sourcePayloads.existsWithHash(source, pageRef, pageHash))) {
    await (await getStorage()).put(pageKey, result.response.body, { contentType: 'text/html' });
    await sourcePayloads.record({ source, ref: pageRef, storageKey: pageKey, hash: pageHash });
  }
  return pageKey;
};

/**
 * One page of a chain, read so that the board moving while the chain walks
 * loses nothing (ticket 39):
 *
 * - **Rows published meanwhile** push the board down, so this page repeats the
 *   previous page's tail. Those entries were read; they are skipped (`isRead`)
 *   and are not a stalled pager.
 * - **A row leaving the board** (an amended e-auction, ticket 29) pulls it up,
 *   so this page's first row moves onto the previous page, already read. So
 *   every page after the first reads the previous page again, *after* reading
 *   its own: a row that moved up before this page was read is on that re-read,
 *   and one that moves up after was on this page. Reading the other way round
 *   loses a row leaving between the two requests; this order covers one
 *   insertion or removal at any moment of the chain. What it does not cover is
 *   a removal before this page's request followed by an insertion between the
 *   two (the row moves up and back down unseen), or a page's worth of rows
 *   moving at once — both need several events within the seconds a chain runs.
 *
 * The cost is one request per page after the first; a chain that reaches its
 * watermark on page 1, the steady state, pays nothing. Throttled on the second
 * request, the job is delayed and asks for both again.
 */
const readPage = async (job, token, board) => {
  const { source } = board;
  const { slug, listingPath, page, chain } = job.data;
  // `sinceTid`/`highTid` and `sincePublished`/`highPublished` are the names
  // pages queued before the chain was shared carry. Drop them once no such
  // job is left in ingest.fetch.
  const since = job.data.since ?? job.data.sinceTid ?? job.data.sincePublished ?? 0;
  const carriedHigh = job.data.high ?? job.data.highTid ?? job.data.highPublished;
  const prevLow = job.data.low;
  const readSoFar = { low: prevLow, lowKeys: job.data.lowKeys ?? [] };
  const unread = (entry) => !isRead(board.markOf(entry), board.keyOf(entry), readSoFar);
  const sourceConfig = getSourceConfig(source);
  const log = logger.child({ job: JOB.LISTING_PAGE, source, slug, page });

  const result = await fetchListingPage(job, token, board, page);

  if (result.notModified) {
    await markSweepHealthy(source);
    log.info('304 not modified — stopping pagination');
    return { notModified: true, continued: false };
  }

  // Page 1 observes the highest mark on the board and carries it down the
  // chain; whichever page terminates the chain commits it as the new
  // watermark.
  const marks = result.entries.map(board.markOf).filter(Number.isFinite);
  const high = carriedHigh ?? (marks.length ? Math.max(...marks) : 0);
  const pageLow = marks.length ? Math.min(...marks) : Infinity;
  const fresh = result.entries.filter(unread);

  const step = nextStep({
    page,
    since,
    pageLow,
    // An entry with no usable mark says nothing about whether the pager moved.
    unread: fresh.filter((entry) => Number.isFinite(board.markOf(entry))).length,
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
      `[${source}] "${slug}" page ${page} holds only ${board.markName} already read ` +
        `(${board.formatMark(pageLow)}..${board.formatMark(Math.max(...marks))}, page ${page - 1}'s oldest ` +
        `${board.formatMark(prevLow)}) — pager did not advance`
    );
  }

  // The previous page again, now that this one is read (see the header).
  // Whatever is on it that the chain had not read moved up from this page or
  // below; an entry this page already showed is not read twice.
  // Unchanged since it was read (a 304) means nothing moved onto it.
  let previous = page > 1 ? await fetchListingPage(job, token, board, page - 1) : null;
  if (previous?.notModified) previous = null;
  const onThisPage = new Set(result.entries.map(board.keyOf));
  const movedUp = previous ? previous.entries.filter((entry) => unread(entry) && !onThisPage.has(board.keyOf(entry))) : [];

  const pageKey = await storeListingPage(board, slug, page, result);
  const previousKey = previous && (await storeListingPage(board, slug, page - 1, previous));

  const tally = {};
  let changed = 0;

  const ingest = async (entries, storageKey) => {
    for (const entry of entries) {
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
      if (!(await sourcePayloads.record({ source, ref: notice.ref, storageKey, hash: notice.hash }))) {
        continue;
      }
      changed += 1;
    }
  };

  await ingest(fresh, pageKey);
  await ingest(movedUp, previousKey);

  await markSweepHealthy(source);

  const range = marks.length ? `${board.formatMark(pageLow)}..${board.formatMark(high)}` : 'none';
  const overlap = result.entries.length - fresh.length;
  log.info(
    `${board.summarize({ result, tally, changed })}` +
      `${overlap ? `; ${overlap} already read` : ''}` +
      `${page > 1 ? `; page ${page - 1} again: ${movedUp.length} moved up onto it` : ''}; ` +
      `${board.markName} ${range} vs watermark ${since ? board.formatMark(since) : 'none'} — ` +
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

  const low = Number.isFinite(pageLow) ? pageLow : prevLow;
  if (step.more) {
    // Every entry of both responses is read by now, so the keys at the new
    // oldest mark are whichever of them hold it.
    const atLow = [...result.entries, ...(previous?.entries ?? [])]
      .filter((entry) => board.markOf(entry) === low)
      .map(board.keyOf);
    const lowKeys = [...new Set([...(low === prevLow ? readSoFar.lowKeys : []), ...atLow])];
    // Ahead of everything else on the queue, whatever the listing's own
    // priority: that decides when a chain starts, and once one has, every
    // minute it waits is a minute for the board to move under it.
    await ingestFetchQueue.add(
      JOB.LISTING_PAGE,
      { source, slug, listingPath, page: page + 1, since, high, low, lowKeys, chain },
      { priority: PRIORITY.CHAIN }
    );
  } else {
    // The floor first (sweepState.js#floorKey): a crash before the watermark
    // moves can only leave the covered window narrower than it is.
    if (!since) await setFloor(floorKey(board.watermarkKey(slug)), low);
    else if (step.capped) await raiseFloor(floorKey(board.watermarkKey(slug)), low);
    await advanceHighWater(board.watermarkKey(slug), high);
  }

  return { entries: result.entries.length, tally, changed, alreadyRead: overlap, movedUp: movedUp.length, continued: step.more };
};

export default { nextStep, isRead, listingsToSweep, sweepBoard, readListingPage };
