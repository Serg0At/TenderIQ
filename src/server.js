import http from 'http';
import 'dotenv/config';

import App from './app.js';
import config from './configs/variables.config.js';
import { closeDb } from './libs/knex.js';
import redis from './libs/redis.js';
import { logger } from './utils/logger.js';

const { PORT } = config;

const init = async () => {
  // Middleware is registered before the server exists, so the very first
  // request cannot slip past a not-yet-mounted error handler.
  const server = http.createServer(App.init());

  server.on('error', (error) => {
    logger.error(`[api] server error: ${error.message}`);
    process.exit(1);
  });

  server.listen(PORT, () => logger.info(`[api] listening on ${PORT}`));

  // Mirrors the worker: finish in-flight requests, then release the pool and
  // the Redis connection, so a deploy does not drop a request mid-write.
  const shutdown = async (signal) => {
    logger.info(`[api] ${signal} received — draining`);
    server.close(async () => {
      try {
        await closeDb();
        await redis.closeRedis();
        logger.info('[api] shutdown complete');
        process.exit(0);
      } catch (error) {
        logger.error(`[api] shutdown failed: ${error.message}`);
        process.exit(1);
      }
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

export default init().catch((error) => {
  logger.error(`[api] failed to start: ${error.message}`);
  process.exit(1);
});
