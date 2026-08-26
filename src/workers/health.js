import config from '../configs/variables.config.js';
import { listEnabledSources, getSourceConfig } from '../configs/sources.config.js';
import { queues } from '../queues/index.js';
import { lastSuccessfulSweep } from './scraper.js';
import { JOB } from '../queues/names.js';
import { logger } from '../utils/logger.js';

/**
 * Is the pipeline actually working?
 *
 * Every signal this reads already existed and was read by nobody: the freshness
 * key was written on every successful page, and dead-lettered jobs accumulated
 * in Redis with `removeOnFail: false` precisely so they could be inspected. A
 * broken parser at 3am and a quiet news day produced identical silence.
 *
 * The spec puts this last in the ingestion build order but is blunt about the
 * stakes: missing tenders are the #1 reason customers churn, and NFR-DATA-1
 * (< 15 min) cannot be a target if nothing measures it.
 *
 * Deliberately NOT measured here: `max(source_payloads.fetched_at)`. Unchanged
 * content is never inserted, so that reports the last *change*, not the last
 * *fetch* — a healthy source that published nothing for an hour would look
 * dead. Sweep health has its own key for exactly this reason.
 */

const { SCRAPER, MONITOR } = config;

const SEVERITY = { OK: 'ok', WARN: 'warn', ALERT: 'alert' };

/** Worst severity wins, so one red check colours the whole report. */
const worst = (levels) =>
  levels.includes(SEVERITY.ALERT)
    ? SEVERITY.ALERT
    : levels.includes(SEVERITY.WARN)
      ? SEVERITY.WARN
      : SEVERITY.OK;

/**
 * Freshness per source, measured against the SLA.
 *
 * "Never swept" is a warning rather than an alert: it is the honest state of a
 * cold start, and crying wolf on first boot trains people to ignore the alarm.
 */
const checkFreshness = async () => {
  const checks = [];

  for (const source of listEnabledSources()) {
    const at = await lastSuccessfulSweep(source);
    const { displayName } = getSourceConfig(source);

    if (!at) {
      checks.push({
        check: 'freshness',
        source,
        severity: SEVERITY.WARN,
        detail: `${displayName}: never completed a sweep`,
      });
      continue;
    }

    const ageMinutes = Math.round((Date.now() - at.getTime()) / 60000);
    const breached = ageMinutes > SCRAPER.FRESHNESS_SLA_MINUTES;

    checks.push({
      check: 'freshness',
      source,
      severity: breached ? SEVERITY.ALERT : SEVERITY.OK,
      ageMinutes,
      slaMinutes: SCRAPER.FRESHNESS_SLA_MINUTES,
      detail: breached
        ? `${displayName}: last successful sweep ${ageMinutes}m ago, over the ${SCRAPER.FRESHNESS_SLA_MINUTES}m SLA`
        : `${displayName}: ${ageMinutes}m since last sweep`,
    });
  }

  return checks;
};

/**
 * Dead-letter depth, plus a sample failure reason.
 *
 * Carrying the reason is what makes the alarm actionable — a count alone still
 * requires someone to go digging through Redis, which is the situation this
 * exists to end.
 */
const checkDeadLetters = async () => {
  const checks = [];
  let total = 0;

  for (const queue of queues) {
    const counts = await queue.getJobCounts();
    total += counts.failed ?? 0;

    if (counts.failed > 0) {
      // A sample, not necessarily the newest — BullMQ does not guarantee the
      // failed set's ordering, and claiming "newest" would mislead triage.
      const [sample] = await queue.getFailed(0, 0);
      checks.push({
        check: 'dead_letters',
        queue: queue.name,
        severity: SEVERITY.OK, // rolled into the aggregate below
        failed: counts.failed,
        detail: `${queue.name}: ${counts.failed} failed`,
        // Deliberately its own field rather than part of `detail`: this is a
        // raw worker exception — Knex rewrites its message to the interpolated
        // SQL plus the Postgres error, so it carries table names, column lists
        // and bound values, and other throws here carry storage keys and
        // upstream URLs. `publicReport` drops it before the unauthenticated
        // /health route answers. An operator reads it in the log.
        sample: (sample?.failedReason || 'unknown').split('\n')[0].slice(0, 120),
      });
    }
  }

  checks.push({
    check: 'dead_letters_total',
    severity: total > MONITOR.DLQ_ALERT ? SEVERITY.ALERT : SEVERITY.OK,
    failed: total,
    threshold: MONITOR.DLQ_ALERT,
    detail: `${total} dead-lettered job(s) across all queues (alert above ${MONITOR.DLQ_ALERT})`,
  });

  return checks;
};

/**
 * Backlog depth — the signal that a worker is down rather than merely busy.
 *
 * A stopped worker looks exactly like a healthy one from the freshness key's
 * point of view until the SLA expires; the queue filling up says so sooner.
 */
const checkBacklog = async () => {
  const checks = [];

  for (const queue of queues) {
    const { waiting = 0, active = 0, delayed = 0, prioritized = 0 } = await queue.getJobCounts();
    const pending = waiting + prioritized + delayed;
    const stalled = pending > MONITOR.BACKLOG_ALERT;

    checks.push({
      check: 'backlog',
      queue: queue.name,
      severity: stalled ? SEVERITY.ALERT : SEVERITY.OK,
      pending,
      active,
      threshold: MONITOR.BACKLOG_ALERT,
      detail: `${queue.name}: ${pending} pending, ${active} active`,
    });
  }

  return checks;
};

/**
 * One pass over every signal. Exported separately from the job so the future
 * `GET /health` endpoint can call exactly the same code rather than growing a
 * second, drifting definition of "healthy".
 */
export const checkHealth = async () => {
  const checks = [
    ...(await checkFreshness()),
    ...(await checkDeadLetters()),
    ...(await checkBacklog()),
  ];

  return {
    severity: worst(checks.map((c) => c.severity)),
    at: new Date().toISOString(),
    checks,
  };
};

/**
 * The client-safe view of the report.
 *
 * `GET /health` is unauthenticated so an uptime probe can reach it, which makes
 * anything in the payload public. `sample` is a verbatim exception message —
 * exactly what middlewares/error.js exists to keep off the wire — so it never
 * crosses the HTTP boundary. The verdict and the counts do, because a health
 * endpoint that reports nothing is not one.
 */
export const publicReport = ({ severity, at, checks }) => ({
  severity,
  at,
  checks: checks.map(({ sample: _sample, ...safe }) => safe),
});

export const handleHealthCheck = async () => {
  const report = await checkHealth();

  // There is no notification channel yet, so severity maps onto log levels and
  // an operator's log-based alerting hooks the ALERT lines. When the notifier
  // exists this is where it plugs in — the report shape is already the payload.
  for (const check of report.checks) {
    const line = `[health] ${check.detail}${check.sample ? ` — sample: ${check.sample}` : ''}`;
    if (check.severity === SEVERITY.ALERT) logger.error(line);
    else if (check.severity === SEVERITY.WARN) logger.warn(line);
    else if (check.sample) logger.warn(line);
  }

  if (report.severity === SEVERITY.OK) {
    logger.info(`[health] ok — ${report.checks.length} checks passed`);
  }

  return report;
};

/**
 * The maintenance lane: health checks and benchmark recomputes. Both are
 * database-only and touch no rate-limited source, so they share one worker
 * rather than each needing a process.
 */
export const processMaintenance = async (job) => {
  if (job.name === JOB.RECOMPUTE_BENCHMARKS) {
    const { handleRecomputeBenchmarks } = await import('./intelligence.js');
    return handleRecomputeBenchmarks(job);
  }
  if (job.name === JOB.RECOMPUTE_PROFILES) {
    const { handleRecomputeProfiles } = await import('./intelligence.js');
    return handleRecomputeProfiles(job);
  }
  return handleHealthCheck(job);
};

export default { checkHealth, publicReport, handleHealthCheck, processMaintenance, SEVERITY };
