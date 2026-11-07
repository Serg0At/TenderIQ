import Joi from 'joi';
import { DelayedError } from 'bullmq';
import notifications from '../repositories/notification.repo.js';
import { sendDigest } from '../services/notifier.service.js';
import { alertsQueue } from '../queues/index.js';
import { JOB, PRIORITY, digestJobId } from '../queues/names.js';
import { logger } from '../utils/logger.js';

/**
 * The daily digest: at 08:00 Asia/Yerevan each daily destination receives the
 * new matches held for it since its last one, as one message.
 *
 * Two jobs, so one destination's slow or throttled provider never holds up
 * another's digest, and a throttle can delay exactly the digest it hit.
 */

/** Job payloads are validated on dequeue: the producer is another process. */
const sendJobSchema = Joi.object({ subscriptionId: Joi.string().max(64).required() }).unknown(false);

/** The calendar date in Yerevan, `YYYY-MM-DD` — the day a morning digest belongs to. */
export const yerevanDate = (at = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Yerevan',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);

/**
 * Queue one `digest.send` per live destination with held matches.
 *
 * The job id names the destination and the Yerevan date, so running this twice
 * on one morning queues each digest once. A day with nothing held queues
 * nothing, and so sends nothing.
 */
export const handleDigestDaily = async ({ now = new Date() } = {}) => {
  const destinations = await notifications.destinationsWithHeld();
  const date = yerevanDate(now);

  for (const { id } of destinations) {
    await alertsQueue.add(
      JOB.DIGEST_SEND,
      { subscriptionId: id },
      { priority: PRIORITY.LIVE, jobId: digestJobId(id, date) }
    );
  }

  if (destinations.length) logger.info(`[digest] ${date}: ${destinations.length} digest(s) queued`);
  return { date, queued: destinations.length };
};

/**
 * Send one destination its digest.
 *
 * Throttled → delayed by the provider's retry-after, the held rows untouched,
 * and no attempt spent: being rate-limited is not the destination's fault, the
 * same rule an alert's deferral follows. Every other outcome is final for this
 * run and already written to the rows by `sendDigest`.
 */
export const handleDigestSend = async (job, token) => {
  const { value, error } = sendJobSchema.validate(job.data);
  if (error) throw new Error(`[digest.send] invalid job payload: ${error.message}`);

  const result = await sendDigest(value.subscriptionId);

  if (result.status === 'deferred') {
    logger.info(`[digest] ${value.subscriptionId} throttled: ${result.detail}`);
    await job.moveToDelayed(Date.now() + result.retryAfterMs, token);
    throw new DelayedError();
  }

  if (result.count) {
    logger.info(
      `[digest] ${value.subscriptionId}: ${result.status}, ${result.tenders ?? 0} tender(s) from ${result.count} held match(es)` +
        (result.detail ? ` — ${result.detail}` : '')
    );
  }
  return { subscriptionId: value.subscriptionId, ...result };
};

export default { handleDigestDaily, handleDigestSend, yerevanDate };
