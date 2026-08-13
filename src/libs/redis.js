import Redis from 'ioredis'
import config from '../configs/variables.config.js';

const { REDIS } = config;

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
