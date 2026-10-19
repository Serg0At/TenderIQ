import { Worker } from 'bullmq';
import { getSourceConfig } from '../configs/sources.config.js';
import redis from '../libs/redis.js';
import { closeQueues } from '../queues/index.js';
import { closeDb } from '../libs/knex.js';
import { QUEUE } from '../queues/names.js';
import mailer from '../libs/adapters/email/index.js';
import { processIngestFetch } from './scraper.js';
import { processIngestNormalize } from './normalizer.js';
import { processMaintenance } from './health.js';
import { processMatch } from './matcher.js';
import { startPolling, stopPolling } from './telegram.js';
import config from '../configs/variables.config.js';
import { logger } from '../utils/logger.js';

/**
 * Worker process. Runs separately from the API so that a parser blowing up on a
 * redesigned page cannot affect request handling, and so the two scale
 * independently.
 */

/**
 * The same boot check `server.js` runs, because this is the process that
 * actually sends alert mail.
 *
 * It used to live only in the API, from when mail was purely a registration and
 * reset concern. Alerts moved that job here, and the guard did not follow: a
 * production worker on `EMAIL_DRIVER=log` would have written every tender alert
 * to a log file and recorded it in `alert_deliveries` as delivered. The API
 * refusing to boot is not cover for it — the two are separate deployables and
 * can be given separate environments.
 *
 * Top-level await on purpose: a throw here fails module evaluation and the
 * process exits non-zero before a single worker is constructed, which is what
 * "refuses to boot" has to mean if it is to mean anything.
 */
await mailer.assertUsable();

const workers = [
  new Worker(QUEUE.INGEST_FETCH, processIngestFetch, {
    connection: redis.connectionOptions,
    concurrency: getSourceConfig('eauction').concurrency,
  }),
  new Worker(QUEUE.INGEST_NORMALIZE, processIngestNormalize, {
    connection: redis.connectionOptions,
    concurrency: getSourceConfig('eauction').concurrency,
  }),
  // Its own queue, so a backed-up fetch queue can never delay the alarm that
  // reports the backlog. Concurrency 1 — it is a read-only status sweep.
  new Worker(QUEUE.MAINTENANCE, processMaintenance, {
    connection: redis.connectionOptions,
    concurrency: 1,
  }),
  // Alerts are latency-sensitive (NFR-PERF-4: delivered < 5 min after
  // ingestion) and touch no rate-limited source, so they get their own lane.
  new Worker(QUEUE.ALERTS, processMatch, {
    connection: redis.connectionOptions,
    concurrency: 4,
  }),
];

/**
 * Inbound Telegram, when this process is the one configured to own it.
 *
 * Started here rather than in the API because `getUpdates` is a single cursor
 * Telegram hands to one consumer at a time: run it in two processes and they
 * fight over the offset, each seeing roughly half the updates. The API may run
 * several replicas behind a load balancer; the worker is the process that has
 * always been singular.
 *
 * Deliberately not awaited — `startPolling` runs until shutdown, and awaiting
 * it here would stop the module ever finishing evaluation.
 */
if (config.TELEGRAM.MODE === 'polling') {
  startPolling().catch((error) => logger.error(`[telegram] polling crashed: ${error.message}`));
} else {
  logger.info(`[telegram] inbound mode is "${config.TELEGRAM.MODE}" — not polling in this process`);
}

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
    // Ask the poll loop to finish its current batch first: it saves its offset
    // only after handling a batch, so cutting it off mid-flight means those
    // updates are redelivered on the next boot.
    stopPolling();
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
