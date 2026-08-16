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
    const { listingCron, refreshCron, displayName } = getSourceConfig(source);

    await ingestFetchQueue.upsertJobScheduler(
      `sweep-${source}`,
      { pattern: listingCron },
      { name: JOB.SOURCE_SWEEP, data: { source } }
    );

    logger.info(`[scheduler] ${displayName}: sweep scheduled "${listingCron}"`);

    // Discovery and settlement are two different questions and run on two
    // different clocks — see JOB.TENDER_REFRESH. Without this second schedule,
    // awards are only ever ingested for tenders that happen to settle while
    // still inside the sweep's tid watermark window.
    if (refreshCron) {
      await ingestFetchQueue.upsertJobScheduler(
        `refresh-${source}`,
        { pattern: refreshCron },
        { name: JOB.TENDER_REFRESH, data: { source } }
      );
      logger.info(`[scheduler] ${displayName}: result re-check scheduled "${refreshCron}"`);
    }
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
