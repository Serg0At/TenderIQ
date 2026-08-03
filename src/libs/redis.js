import Redis from 'ioredis'
import config from '../configs/variables.config.js';

const { REDIS } = config;

/**
 * Connection options shared by BullMQ queues/workers and by the rate limiter.
 * `maxRetriesPerRequest: null` is required by BullMQ for its blocking commands.
 */
const connectionOptions = {
  host: REDIS.HOST,
  port: REDIS.PORT,
  password: REDIS.PASSWORD,
  db: REDIS.DB,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  ...(REDIS.TLS ? { tls: {} } : {}),
};

let client = null;

/** Shared client for non-queue use: rate limiting, conditional-GET cache, locks. */
const getRedis = () => {
  if (!client) client = new Redis(connectionOptions);
  return client;
};

const closeRedis = async () => {
  if (client) {
    await client.quit();
    client = null;
  }
};

export default { connectionOptions, getRedis, closeRedis };
