import { Queue } from 'bullmq';
import config from '../configs/variables.config.js';
import redis from '../libs/redis.js';
import { QUEUE } from './names.js';

const { SCRAPER } = config;

/**
 * Retry policy from config, applied to every queue.
 *
 * removeOnFail is false on purpose: BullMQ's failed set IS the dead-letter
 * queue. Dropping failures would erase the only record of a parser that broke
 * at 3am.
 */
const defaultJobOptions = {
  attempts: SCRAPER.MAX_ATTEMPTS,
  backoff: { type: 'exponential', delay: SCRAPER.BACKOFF_BASE_MS },
  removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
  removeOnFail: false,
};

const connection = redis.connectionOptions;

export const ingestFetchQueue = new Queue(QUEUE.INGEST_FETCH, { connection, defaultJobOptions });
export const ingestNormalizeQueue = new Queue(QUEUE.INGEST_NORMALIZE, {
  connection,
  defaultJobOptions,
});

export const ingestBackfillQueue = new Queue(QUEUE.INGEST_BACKFILL, {
  connection,
  defaultJobOptions,
});

export const maintenanceQueue = new Queue(QUEUE.MAINTENANCE, { connection, defaultJobOptions });

export const alertsQueue = new Queue(QUEUE.ALERTS, { connection, defaultJobOptions });

export const inferenceQueue = new Queue(QUEUE.INFERENCE, { connection, defaultJobOptions });

export const queues = [
  ingestFetchQueue,
  ingestNormalizeQueue,
  ingestBackfillQueue,
  maintenanceQueue,
  alertsQueue,
  inferenceQueue,
];

export const closeQueues = async () => {
  await Promise.all(queues.map((queue) => queue.close()));
};

export default {
  ingestFetchQueue,
  ingestNormalizeQueue,
  ingestBackfillQueue,
  maintenanceQueue,
  alertsQueue,
  inferenceQueue,
  queues,
  closeQueues,
};
