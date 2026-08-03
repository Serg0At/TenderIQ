import { Worker } from 'bullmq';
import { getSourceConfig } from '../configs/sources.config.js';
import redis from '../libs/redis.js';
import { closeDb } from '../libs/knex.js';
import { closeQueues } from '../queues/index.js';
import { QUEUE } from '../queues/names.js';
import { processIngestFetch } from './scraper.js';
import { logger } from '../utils/logger.js';

/**
 * Worker process. Runs separately from the API so that a parser blowing up on a
 * redesigned page cannot affect request handling, and so the two scale
 * independently.
 */
const workers = [
  new Worker(QUEUE.INGEST_FETCH, processIngestFetch, {
    connection: redis.connectionOptions,
    // Politeness ceiling for the source, not a throughput target.
    concurrency: getSourceConfig('armeps').concurrency,
  }),
];

for (const worker of workers) {
  worker.on('ready', () => logger.info(`[worker] ${worker.name} ready`));

  worker.on('completed', (job, result) =>
    logger.info(`[worker] ${worker.name}/${job.name} completed`, { result })
  );

  // Logged with the attempt count so "failed once and recovered" is visually
  // distinct from "exhausted its attempts and is now dead-lettered".
  worker.on('failed', (job, error) =>
    logger.error(
      `[worker] ${worker.name}/${job?.name} failed ` +
        `(attempt ${job?.attemptsMade}/${job?.opts?.attempts}): ${error.message}`
    )
  );

  worker.on('error', (error) => logger.error(`[worker] ${worker.name} error`, error));
}

/**
 * Graceful shutdown: worker.close() waits for in-flight jobs to finish rather
 * than dropping them mid-fetch. Without it, a deploy during a sweep leaves a
 * job stalled until BullMQ's stall detector reclaims it.
 */
const shutdown = async (signal) => {
  logger.info(`[worker] ${signal} received — draining`);
  try {
    await Promise.all(workers.map((worker) => worker.close()));
    await closeQueues();
    await closeDb();
    await redis.closeRedis();
    logger.info('[worker] shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('[worker] shutdown failed', error);
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
