import config from '../configs/variables.config.js';
import { listEnabledSources, getSourceConfig } from '../configs/sources.config.js';
import redis from '../libs/redis.js';
import { ingestFetchQueue, maintenanceQueue, alertsQueue, closeQueues } from './index.js';
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

  // Source-independent: it reports on every source and on the queues
  // themselves, so it is registered once rather than per source.
  await maintenanceQueue.upsertJobScheduler(
    'health-check',
    { pattern: config.MONITOR.CRON },
    { name: JOB.HEALTH_CHECK, data: {} }
  );
  logger.info(`[scheduler] health check scheduled "${config.MONITOR.CRON}"`);

  // Hourly: deadlines move in hours, not minutes, and the two thresholds are
  // 72h and 24h out — a tighter cadence would only re-scan the same rows.
  await alertsQueue.upsertJobScheduler(
    'deadline-reminders',
    { pattern: '7 * * * *' },
    { name: JOB.DEADLINE_REMINDER, data: {} }
  );
  logger.info('[scheduler] deadline reminders scheduled "7 * * * *"');

  // Every 10 minutes. A quiet window ends on an hour boundary, so this bounds
  // the extra delay a deferred alert suffers to 10 minutes — comfortably inside
  // the 5-minute target measured from the moment it becomes deliverable, and
  // cheap because the sweep is a single indexed query that usually returns none.
  await alertsQueue.upsertJobScheduler(
    'deferred-deliveries',
    { pattern: '*/10 * * * *' },
    { name: JOB.DELIVER_DEFERRED, data: {} }
  );
  logger.info('[scheduler] deferred alert sweep scheduled "*/10 * * * *"');

  // Nightly full recompute. Repairs anything the targeted path missed, and
  // promotes categories that only now cleared the comparables threshold
  // because the seed advanced.
  await maintenanceQueue.upsertJobScheduler(
    'benchmarks-nightly',
    { pattern: '23 3 * * *' },
    { name: JOB.RECOMPUTE_BENCHMARKS, data: {} }
  );
  logger.info('[scheduler] nightly benchmark recompute scheduled "23 3 * * *"');

  // Profiles after benchmarks, not alongside them. Both walk the award corpus
  // and both run on the maintenance queue at concurrency 1, so an overlapping
  // schedule would only queue one behind the other anyway — staggering makes
  // that explicit and keeps each job's duration readable in the logs.
  await maintenanceQueue.upsertJobScheduler(
    'profiles-nightly',
    { pattern: '41 4 * * *' },
    { name: JOB.RECOMPUTE_PROFILES, data: {} }
  );
  logger.info('[scheduler] nightly profile rebuild scheduled "41 4 * * *"');

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
