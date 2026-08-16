import { DelayedError, UnrecoverableError, Worker } from 'bullmq';
import { getSourceConfig } from '../configs/sources.config.js';
import redis from '../libs/redis.js';
import { closeDb } from '../libs/knex.js';
import { getStorage, rawKey } from '../libs/storage/index.js';
import { fetchListing, RateLimitedError } from '../libs/adapters/source/armeps/client.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';
import { ingestBackfillQueue, closeQueues } from '../queues/index.js';
import { JOB, QUEUE, PRIORITY } from '../queues/names.js';
import { sha256, stableHash } from '../utils/hash.js';
import { logger } from '../utils/logger.js';
import { handleTenderDetail } from './scraper.js';
import { handleTenderDocuments } from './documents.js';

/**
 * One-time historical seed of the eauction archive.
 *
 * WHY THIS IS SEPARATE FROM THE SWEEP
 *
 * The 5-minute sweep answers "what is new?" and stops at its tid watermark,
 * which in steady state is page 1. The hourly refresh answers "what has
 * settled?" and is driven from the database. Neither can reach a tender that
 * was published and settled before the system ever ran — and that is ~97% of
 * the board. Sampling 15 listing pages: page 3 is 30/30 active, page 20 is
 * 0/30, and everything past it is finished or cancelled.
 *
 * That archive is the entire benchmark corpus. Measured over 6 sampled
 * finished tenders: 7.8 lots and 26.3 bids each, every one carrying a budget
 * price alongside the winning offer. Across ~29,000 archived tenders that is
 * roughly 230,000 awards and 773,000 comparable bids.
 *
 * DESIGN
 *
 * - Own queue and own process, so a multi-day run can be stopped and resumed
 *   without touching the live pipeline. Politeness is unaffected: the rate
 *   limiter is keyed per source in Redis and shared across processes.
 * - Newest-first. Stopping halfway leaves the most recent — and most
 *   commercially relevant — history ingested, rather than a random slice.
 * - Chained one page at a time. The next page is a waiting job in Redis, which
 *   runs with appendonly persistence, so killing the process and restarting it
 *   days later continues where it stopped. That is the whole resumption
 *   mechanism; there is no separate cursor to corrupt.
 * - Low priority on every normalize job it produces, so a newly published
 *   tender never queues behind hours of history.
 * - Idempotent. Re-running a page costs requests but writes nothing: the
 *   listing fingerprint and the detail content hash both dedupe.
 */

/** Mirrors the sweep's fingerprint so a seeded row and a swept row agree. */
const rowFingerprint = (row) =>
  stableHash({
    sourceId: row.sourceId,
    code: row.code,
    title: row.title,
    status: row.status,
    deadlineAt: row.deadlineAt,
  });

const progressKey = (source, slug) => `backfill:${source}:${slug}`;

export const backfillProgress = async (source, slug) => {
  const raw = await redis.getRedis().get(progressKey(source, slug));
  return raw ? JSON.parse(raw) : null;
};

const handleBackfillPage = async (job, token) => {
  const { source, slug, listingPath, page, toPage, queued = 0 } = job.data;
  const log = logger.child({ job: JOB.BACKFILL_PAGE, source, page, toPage });

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

  // Same layout alarm as the sweep. A seed that silently ingests nothing for
  // 900 pages would be far worse than one that stops on page 3.
  if (result.blocksSeen === 0) {
    throw new Error(
      `[${source}] backfill page ${page} returned 200 with 0 rows — parser likely broken`
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

  let enqueued = 0;
  for (const row of result.rows) {
    const ref = `notice:${row.sourceId}`;
    const hash = rowFingerprint(row);

    if (await sourcePayloads.existsWithHash(source, ref, hash)) continue;

    // Enqueue before recording, for the same reason as the sweep: a crash
    // between the two would otherwise mark the notice seen with no detail job,
    // and no later pass would ever revisit it.
    await ingestBackfillQueue.add(
      JOB.TENDER_DETAIL,
      { source, sourceId: row.sourceId, priority: PRIORITY.BACKFILL },
      {
        jobId: `${source}-backfill-${row.sourceId}-${hash.slice(0, 12)}`,
        priority: PRIORITY.BACKFILL,
      }
    );

    if (!(await sourcePayloads.record({ source, ref, storageKey: pageKey, hash }))) continue;
    enqueued += 1;
  }

  const totalQueued = queued + enqueued;
  const nextPage = page + 1;
  const shouldContinue = nextPage <= toPage;

  // Checkpoint is observational: resumption comes from the chained job in
  // Redis, not from this key. It exists so an operator can see where a run that
  // has been going for two days has actually reached.
  await redis
    .getRedis()
    .set(
      progressKey(source, slug),
      JSON.stringify({ page, toPage, totalQueued, at: new Date().toISOString() })
    );

  log.info(
    `${result.rows.length} rows, ${enqueued} new details queued ` +
      `(${totalQueued} so far) — ${shouldContinue ? `next page ${nextPage}` : 'COMPLETE'}`
  );

  if (shouldContinue) {
    await ingestBackfillQueue.add(
      JOB.BACKFILL_PAGE,
      { source, slug, listingPath, page: nextPage, toPage, queued: totalQueued },
      { priority: PRIORITY.BACKFILL }
    );
  } else {
    log.info(`backfill complete — ${totalQueued} detail pages queued across ${toPage} pages`);
  }

  return { page, enqueued, totalQueued, continued: shouldContinue };
};

export const processBackfill = async (job, token) => {
  switch (job.name) {
    case JOB.BACKFILL_PAGE:
      return handleBackfillPage(job, token);
    // Reuses the sweep's handler rather than duplicating it — same storage
    // keys, same dedupe, same normalize hand-off. Only the queue differs.
    case JOB.TENDER_DETAIL:
      return handleTenderDetail(job, token);
    case JOB.TENDER_DOCUMENTS:
      return handleTenderDocuments(job, token);
    default:
      throw new UnrecoverableError(`unknown job "${job.name}" on ${QUEUE.INGEST_BACKFILL}`);
  }
};

/**
 * Enqueue the first page. Safe to call when a run is already in flight — the
 * existing chain keeps going and this adds a second starting point, so check
 * `backfillProgress()` first if that is not what you want.
 */
export const startBackfill = async ({ source = 'armeps', fromPage = 2, toPage } = {}) => {
  const sourceConfig = getSourceConfig(source);
  const board = sourceConfig.listingPaths[0];

  // Discover the real end of the archive rather than trusting a hard-coded
  // number that silently rots as the board grows.
  let lastPage = toPage;
  if (!lastPage) {
    const probe = await fetchListing(board.path, 1);
    lastPage = probe.pagination?.lastPage ?? 1;
  }

  await ingestBackfillQueue.add(
    JOB.BACKFILL_PAGE,
    { source, slug: board.slug, listingPath: board.path, page: fromPage, toPage: lastPage, queued: 0 },
    // Deterministic id so running `backfill:start` twice does not create two
    // concurrent chains competing for one rate budget.
    { jobId: `${source}-backfill-seed-${fromPage}`, priority: PRIORITY.BACKFILL }
  );

  logger.info(`[backfill] queued pages ${fromPage}..${lastPage} of "${board.slug}"`);
  return { fromPage, toPage: lastPage };
};

/**
 * Run as a process:
 *   node src/workers/backfill.js            # resume whatever is queued
 *   node src/workers/backfill.js --start    # queue page 2..last, then run
 *   node src/workers/backfill.js --start --from 2 --to 100
 */
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : Number(process.argv[index + 1]);
  };

  if (process.argv.includes('--start')) {
    await startBackfill({ fromPage: arg('from', 2), toPage: arg('to', undefined) });
  } else {
    const progress = await backfillProgress('armeps', getSourceConfig('armeps').listingPaths[0].slug);
    logger.info(
      progress
        ? `[backfill] resuming — last checkpoint page ${progress.page}/${progress.toPage}, ` +
            `${progress.totalQueued} details queued at ${progress.at}`
        : '[backfill] no checkpoint found — pass --start to begin a run'
    );
  }

  const worker = new Worker(QUEUE.INGEST_BACKFILL, processBackfill, {
    connection: redis.connectionOptions,
    // Deliberately 1: the seed is bounded by the shared per-source rate budget,
    // not by parallelism, and a second slot would only steal turns from the
    // live pipeline.
    concurrency: 1,
  });

  worker.on('ready', () => logger.info(`[backfill] worker ready on ${QUEUE.INGEST_BACKFILL}`));
  worker.on('failed', (job, error) =>
    logger.error(
      `[backfill] ${job?.name} failed (attempt ${job?.attemptsMade}/${job?.opts?.attempts}): ${error.message}`
    )
  );
  worker.on('error', (error) => logger.error('[backfill] worker error', error));

  const shutdown = async (signal) => {
    // The in-flight page finishes and the next one stays queued in Redis, so
    // restarting picks up exactly where this left off.
    logger.info(`[backfill] ${signal} received — finishing current page, next stays queued`);
    try {
      await worker.close();
      await closeQueues();
      await closeDb();
      await redis.closeRedis();
      logger.info('[backfill] stopped cleanly — rerun without --start to resume');
      process.exit(0);
    } catch (error) {
      logger.error('[backfill] shutdown failed', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export default { processBackfill, startBackfill, backfillProgress };
