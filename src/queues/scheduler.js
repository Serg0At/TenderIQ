import { listEnabledSources, getSourceConfig } from '../configs/sources.config.js';
import redis from '../libs/redis.js';
import { ingestFetchQueue, closeQueues } from './index.js';
import { JOB } from './names.js';
import { logger } from '../utils/logger.js';

/**
 * Registers the repeatable sweep jobs, then exits.
 *
 * Run it on deploy, not as a long-lived process: BullMQ persists repeatable
 * schedules in Redis, so the cron keeps firing without anything supervising it.
 * The scheduler ID is derived from the source key, so re-running replaces the
 * schedule instead of stacking a second one.
 */
const register = async () => {
  for (const source of listEnabledSources()) {
    const { listingCron, displayName } = getSourceConfig(source);

    // Only armeps has a listing scraper so far; ppcm is a CSV importer (v2).
    if (source !== 'armeps') {
      logger.info(`[scheduler] skipping "${source}" — no listing scraper yet`);
      continue;
    }

    await ingestFetchQueue.upsertJobScheduler(
      `sweep-${source}`,
      { pattern: listingCron },
      { name: JOB.SOURCE_SWEEP, data: { source } }
    );

    logger.info(`[scheduler] ${displayName}: sweep scheduled "${listingCron}"`);
  }

  const schedulers = await ingestFetchQueue.getJobSchedulers();
  logger.info(`[scheduler] active schedules: ${schedulers.map((s) => s.key).join(', ') || 'none'}`);
};

register()
  .then(async () => {
    await closeQueues();
    await redis.closeRedis();
    process.exit(0);
  })
  .catch(async (error) => {
    logger.error('[scheduler] failed', error);
    process.exit(1);
  });
