import { Worker } from 'bullmq';
import { getSourceConfig } from '../configs/sources.config.js';
import redis from '../libs/redis.js';
import { closeQueues } from '../queues/index.js';
import { closeDb } from '../libs/knex.js';
import { QUEUE } from '../queues/names.js';
import { processIngestFetch } from './scraper.js';
import { processIngestNormalize } from './normalizer.js';
import { logger } from '../utils/logger.js';

/**
 * Worker process. Runs separately from the API so that a parser blowing up on a
 * redesigned page cannot affect request handling, and so the two scale
 * independently.
 */
const workers = [
  new Worker(QUEUE.INGEST_FETCH, processIngestFetch, {
    connection: redis.connectionOptions,
    concurrency: getSourceConfig('armeps').concurrency,
  }),
  new Worker(QUEUE.INGEST_NORMALIZE, processIngestNormalize, {
    connection: redis.connectionOptions,
    concurrency: getSourceConfig('armeps').concurrency,
  }),
];

for (const worker of workers) {
  worker.on('ready', () => logger.info(`[worker] ${worker.name} ready`));

  worker.on('completed', (job, result) =>
    logger.info(`[worker] ${worker.name}/${job.name} completed`, { result })
  );

  worker.on('failed', (job, error) =>
    logger.error(
      `[worker] ${worker.name}/${job?.name} failed ` +
        `(attempt ${job?.attemptsMade}/${job?.opts?.attempts}): ${error.message}`
    )
  );

  worker.on('error', (error) => logger.error(`[worker] ${worker.name} error`, error));
}
// Graceful shutdown
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
