import { DelayedError, UnrecoverableError } from 'bullmq';
import config from '../configs/variables.config.js';
import { getSourceConfig } from '../configs/sources.config.js';
import redis from '../libs/redis.js';
import { getStorage, rawKey } from '../libs/storage/index.js';
import { fetchListing, RateLimitedError } from '../libs/adapters/source/armeps/client.js';
import sourcePayloads from '../repositories/sourcePayload.repository.js';
import { ingestFetchQueue, ingestNormalizeQueue } from '../queues/index.js';
import { JOB } from '../queues/names.js';
import { sha256, stableHash } from '../utils/hash.js';
import { withLock } from '../utils/rateLimiter.js';
import { logger } from '../utils/logger.js';

const { SCRAPER } = config;

const markSweepHealthy = (source) =>
  redis.getRedis().set(`sweep:ok:${source}`, Date.now(), 'EX', 7 * 24 * 60 * 60);

export const lastSuccessfulSweep = async (source) => {
  const value = await redis.getRedis().get(`sweep:ok:${source}`);
  return value ? new Date(Number(value)) : null;
};

/**
 * Fields that define "this notice changed".
 *
 * Deliberately excludes the URL: if the source ever changed its URL scheme,
 * every tender in the system would flag as amended at once and re-notify every
 * customer. Title is included, so a buyer rewording the subject does re-alert —
 * the accepted cost of catching material rewordings.
 */
const rowFingerprint = (row) =>
  stableHash({
    sourceId: row.sourceId,
    title: row.title,
    publishedAt: row.publishedAt,
    deadlineAt: row.deadlineAt,
  });

const handleSweep = async (job) => {
  const { source } = job.data;
  const sourceConfig = getSourceConfig(source);
  const log = logger.child({ job: JOB.SOURCE_SWEEP, source });

  // A post-outage deep sweep can outlast the 5-minute cron; without this, runs
  // stack up and the scraper rate-limits itself into a spiral.
  const { skipped } = await withLock(`sweep:${source}`, 10 * 60 * 1000, async () => {
    const since = new Date(Date.now() - sourceConfig.lookbackHours * 60 * 60 * 1000);

    for (const board of sourceConfig.listingPaths) {
      await ingestFetchQueue.add(JOB.LISTING_PAGE, {
        source,
        slug: board.slug,
        listingPath: board.path,
        page: 1,
        since: since.toISOString(),
      });
      log.info(`enqueued page 1 of "${board.slug}" (since ${since.toISOString()})`);
    }
  });

  if (skipped) log.warn('previous sweep still running — skipped');
  return { skipped };
};

const handleListingPage = async (job, token) => {
  const { source, slug, listingPath, page, since } = job.data;
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

  const skipped = result.skipped ?? { noResourceId: 0, duplicate: 0 };
  if (skipped.noResourceId > 0) {
    log.info(
      `skipped ${skipped.noResourceId}/${result.blocksSeen} non-ARMEPS notices (no resourceId)`
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

  let changed = 0;
  for (const row of result.rows) {
    const ref = `notice:${row.sourceId}`;
    const hash = rowFingerprint(row);

    if (await sourcePayloads.existsWithHash(source, ref, hash)) continue;

    const inserted = await sourcePayloads.record({ source, ref, storageKey: pageKey, hash });
    // A concurrent worker won the race and already recorded it — not our job to
    // enqueue normalization twice.
    if (!inserted) continue;

    changed += 1;
    await ingestNormalizeQueue.add(
      JOB.NORMALIZE_TENDER,
      { source, sourceId: row.sourceId, ref, hash, storageKey: pageKey, row },
      { jobId: `${source}-${row.sourceId}-${hash.slice(0, 12)}` }
    );
  }

  await markSweepHealthy(source);

  const oldest = result.rows
    .map((row) => row.publishedAt)
    .filter(Boolean)
    .sort((a, b) => a - b)[0];
  const withinWindow = oldest ? oldest >= new Date(since) : true;

  const maxPage = Math.min(
    result.pagination?.lastPage ?? 1,
    sourceConfig.maxListingPages,
    SCRAPER.MAX_LISTING_PAGES
  );
  const shouldContinue = withinWindow && page < maxPage;

  log.info(
    `${result.blocksSeen} blocks, ${result.rows.length} usable, ${changed} new/changed, ` +
      `oldest ${oldest?.toISOString()} — ` +
      `${shouldContinue ? `continuing to page ${page + 1}` : 'stopping (outside lookback window)'}`
  );

  if (shouldContinue) {
    await ingestFetchQueue.add(JOB.LISTING_PAGE, {
      source,
      slug,
      listingPath,
      page: page + 1,
      since,
    });
  }

  return { rows: result.rows.length, changed, continued: shouldContinue };
};

/** Processor for the ingest.fetch queue. */
export const processIngestFetch = async (job, token) => {
  switch (job.name) {
    case JOB.SOURCE_SWEEP:
      return handleSweep(job);
    case JOB.LISTING_PAGE:
      return handleListingPage(job, token);
    default:
      throw new UnrecoverableError(`unknown job "${job.name}" on ingest.fetch`);
  }
};

export default { processIngestFetch, lastSuccessfulSweep };
