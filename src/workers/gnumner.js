import { DelayedError } from 'bullmq';
import config from '../configs/variables.config.js';
import { getSourceConfig } from '../configs/sources.config.js';
import { getStorage, rawKey } from '../libs/storage/index.js';
import { fetchListing } from '../libs/adapters/source/gnumner/client.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';
import { ingestFetchQueue } from '../queues/index.js';
import { JOB, PRIORITY } from '../queues/names.js';
import { sha256, stableHash } from '../utils/hash.js';
import { withLock, RateLimitedError } from '../utils/rateLimiter.js';
import { markSweepHealthy, readHighWater, advanceHighWater } from '../utils/sweepState.js';
import { logger } from '../utils/logger.js';

const { SCRAPER } = config;
const SOURCE = 'gnumner';

/**
 * Newest publish datetime (epoch ms) seen by a *completed* sweep of a listing.
 *
 * gnumner's listings carry no ids, so this is the analogue of eauction's tid
 * watermark: each listing is sorted newest-first by publish datetime, so a
 * page whose oldest item is at or below the mark is a page we have already
 * read down to.
 */
const publishedWatermarkKey = (slug) => `sweep:published:${SOURCE}:${slug}`;

/**
 * The paper identity is the uploaded file's path, which can run long and
 * carries runs of spaces (non-ASCII characters in the original name become
 * spaces), so refs and job ids use a digest of it. The path itself travels in
 * the job.
 */
const pathDigest = (path) => sha256(path).slice(0, 24);

const noticeRef = (item) =>
  item.kind === 'paper'
    ? `notice:paper:${pathDigest(item.externalId)}`
    : `notice:${item.kind}:${item.externalId}`;

/**
 * Fields that define "this notice changed". The link target is the identity
 * here, so it is in the ref rather than the fingerprint; the title and the
 * announced window are what a buyer edits.
 */
const itemFingerprint = (item) =>
  stableHash({
    kind: item.kind,
    externalId: item.externalId,
    title: item.title,
    procedureCode: item.procedureCode,
    publishedAt: item.publishedAt,
    closesAt: item.closesAt,
  });

const excludedBuyer = (item, excludedBuyers) =>
  excludedBuyers.find(({ pattern }) => pattern.test(item.title)) ?? null;

const discoveryJob = (item, { slug, ref, hash }) => {
  const discovery = {
    source: SOURCE,
    slug,
    url: item.url,
    title: item.title,
    procedureCode: item.procedureCode,
    publishedAt: item.publishedAt.toISOString(),
    closesAt: item.closesAt ? item.closesAt.toISOString() : null,
    listingRef: ref,
    listingHash: hash,
  };

  if (item.kind === 'armeps') {
    return {
      name: JOB.ARMEPS_DETAIL,
      data: { source: 'armeps', resourceId: item.externalId, discovery },
      opts: { jobId: `armeps-detail-${item.externalId}-${hash.slice(0, 12)}`, priority: PRIORITY.LIVE },
    };
  }

  return {
    name: JOB.PAPER_INVITATION,
    data: { source: SOURCE, path: item.externalId, fileType: item.fileType, ...discovery },
    opts: {
      jobId: `gnumner-paper-${pathDigest(item.externalId)}-${hash.slice(0, 12)}`,
      priority: PRIORITY.LIVE,
    },
  };
};

export const handleGnumnerSweep = async (job) => {
  const sourceConfig = getSourceConfig(SOURCE);
  const log = logger.child({ job: JOB.SOURCE_SWEEP, source: SOURCE });

  const { skipped } = await withLock(`sweep:${SOURCE}`, 10 * 60 * 1000, async () => {
    for (const board of sourceConfig.listingPaths) {
      // Read once, at the top of the chain, so a notice published mid-sweep
      // cannot move the goalposts under the pages still in flight.
      const sincePublished = await readHighWater(publishedWatermarkKey(board.slug));

      await ingestFetchQueue.add(
        JOB.LISTING_PAGE,
        { source: SOURCE, slug: board.slug, listingPath: board.path, page: 1, sincePublished },
        { priority: PRIORITY.LIVE }
      );
      log.info(`enqueued page 1 of "${board.slug}" (since ${sincePublished ? new Date(sincePublished).toISOString() : 'never'})`);
    }
  });

  if (skipped) log.warn('previous sweep still running — skipped');
  return { skipped };
};

export const handleGnumnerListingPage = async (job, token) => {
  const { slug, listingPath, page, sincePublished = 0 } = job.data;
  const sourceConfig = getSourceConfig(SOURCE);
  const log = logger.child({ job: JOB.LISTING_PAGE, source: SOURCE, slug, page });

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

  if (result.blocksSeen === 0) {
    throw new Error(
      `[${SOURCE}] "${slug}" page ${page} returned 200 with 0 notice blocks — parser likely broken`
    );
  }

  const storage = await getStorage();
  const pageHash = sha256(result.response.body);
  const pageRef = `listing:${slug}:p${page}`;
  const pageKey = rawKey({ source: SOURCE, ref: pageRef, hash: pageHash, ext: 'html' });

  if (!(await sourcePayloads.existsWithHash(SOURCE, pageRef, pageHash))) {
    await storage.put(pageKey, result.response.body, { contentType: 'text/html' });
    await sourcePayloads.record({ source: SOURCE, ref: pageRef, storageKey: pageKey, hash: pageHash });
  }

  // Per classification, for the coverage check: every block on the page is in
  // exactly one of these or in result.skipped.
  const counts = { armeps: 0, paper: 0, eauction: 0, excluded: 0, other: 0 };
  let changed = 0;

  for (const item of result.items) {
    if (item.kind === 'eauction') {
      // Counted for coverage only. A tmid cannot be mapped to a tid today, and
      // the eauction board already ingests every e-auction directly.
      counts.eauction += 1;
      continue;
    }

    if (item.kind === 'other') {
      counts.other += 1;
      log.warn(`unrecognised link target — not ingested: ${item.url}`);
      continue;
    }

    if (item.kind === 'paper') {
      const excluded = excludedBuyer(item, sourceConfig.excludedBuyers);
      if (excluded) {
        counts.excluded += 1;
        continue;
      }
    }

    counts[item.kind] += 1;

    const ref = noticeRef(item);
    const hash = itemFingerprint(item);
    if (await sourcePayloads.existsWithHash(SOURCE, ref, hash)) continue;

    // The listing writes no domain rows: it knows a link and a title, not a
    // buyer. Enqueue BEFORE recording the fingerprint — the reverse order lets
    // a crash between the two mark a notice seen with no job behind it, a
    // permanent coverage hole. This order can only duplicate, and the jobId
    // dedupes that.
    const next = discoveryJob(item, { slug, ref, hash });
    await ingestFetchQueue.add(next.name, next.data, next.opts);

    if (!(await sourcePayloads.record({ source: SOURCE, ref, storageKey: pageKey, hash }))) continue;
    changed += 1;
  }

  await markSweepHealthy(SOURCE);

  // Depth control, the same rule as eauction's tid watermark: page 1 observes
  // the newest publish datetime and carries it down the chain; whichever page
  // terminates the chain commits it.
  const published = result.items.map((item) => item.publishedAt.getTime());
  const highPublished = job.data.highPublished ?? (published.length ? Math.max(...published) : 0);
  const pageOldest = published.length ? Math.min(...published) : Infinity;

  // maxListingPages bounds a cold start only. With a watermark, the chain
  // walks until it reaches it — after an outage that is the gap to re-read —
  // and only the global ceiling stops it. The site's own page total is never
  // consulted; whether a next page exists is.
  const cap = sincePublished
    ? SCRAPER.MAX_LISTING_PAGES
    : Math.min(sourceConfig.maxListingPages, SCRAPER.MAX_LISTING_PAGES);
  const reachedSeen = pageOldest <= sincePublished;
  const shouldContinue = !reachedSeen && result.hasNextPage && page < cap;

  const reason = reachedSeen
    ? 'reached the watermark'
    : !result.hasNextPage
      ? 'no next page'
      : `page cap ${cap}`;

  log.info(
    `${result.blocksSeen} blocks: ${counts.armeps} armeps, ${counts.paper} paper, ` +
      `${counts.eauction} eauction, ${counts.excluded} excluded, ${counts.other} other, ` +
      `${result.skipped.duplicate} duplicate, ${result.skipped.noLink + result.skipped.noDate} unreadable; ` +
      `${changed} new/changed — ${shouldContinue ? `continuing to page ${page + 1}` : `stopping (${reason})`}`
  );

  if (!shouldContinue && sincePublished && !reachedSeen) {
    // Advancing past an unread gap is the cost of a bounded walk; say so.
    log.warn(`chain ended at page ${page} without reaching the watermark — older notices were not read`);
  }

  if (shouldContinue) {
    await ingestFetchQueue.add(
      JOB.LISTING_PAGE,
      { source: SOURCE, slug, listingPath, page: page + 1, sincePublished, highPublished },
      { priority: PRIORITY.LIVE }
    );
  } else {
    await advanceHighWater(publishedWatermarkKey(slug), highPublished);
  }

  return { counts, skipped: result.skipped, changed, continued: shouldContinue };
};

/**
 * Discoveries whose consumers have not landed yet (tickets 05 and 06) are
 * parked, not failed: moved back to delayed without spending an attempt, so
 * they stay recorded in Redis and the real handler picks them up the first
 * time it sees them. Replace this with the handler when it exists.
 */
const PARK_MS = 6 * 60 * 60 * 1000;

export const parkUntilConsumerExists = async (job, token) => {
  await job.moveToDelayed(Date.now() + PARK_MS, token);
  throw new DelayedError();
};

export default { handleGnumnerSweep, handleGnumnerListingPage, parkUntilConsumerExists };
