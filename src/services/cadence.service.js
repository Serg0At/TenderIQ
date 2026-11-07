import subscriptions from '../repositories/channelSubscription.repo.js';
import notifications from '../repositories/notification.repo.js';
import { alertsQueue } from '../queues/index.js';
import { JOB, PRIORITY, digestFlushJobId } from '../queues/names.js';
import { logger } from '../utils/logger.js';

/**
 * Switching a destination between `instant` and `daily`, for either channel.
 *
 * The held rows are the cursor, so a switch needs no timestamp of its own:
 *
 * - instant → daily: everything before the switch was already `sent`, and only
 *   matches that arrive after it are held — nothing is repeated;
 * - daily → instant: what was held is flushed now as one digest, through the
 *   same `digest.send` the morning run uses, so a switch never loses a match.
 *   With nothing held, nothing is queued and nothing is sent.
 *
 * The flush is queued only when the row really moved off `daily` — the
 * previous value is read under the row lock — so a toggle pressed twice queues
 * one digest, not two.
 *
 * Returns the updated row, or null when the caller owns no such destination on
 * that channel; the channel's service decides how to say "not found".
 */
export const switchCadence = async ({ organizationId, userId, id, channel, cadence, now = new Date() }) => {
  const result = await subscriptions.setCadence({ id, organizationId, userId, channel, cadence });
  if (!result) return null;

  const { row, previous } = result;
  if (previous === 'daily' && cadence === 'instant') {
    const held = await notifications.hasHeld({ subscriptionId: row.id, organizationId });
    if (held) {
      await alertsQueue.add(
        JOB.DIGEST_SEND,
        { subscriptionId: row.id },
        { priority: PRIORITY.LIVE, jobId: digestFlushJobId(row.id, now) }
      );
      logger.info(`[digest] ${row.id} switched to instant: held matches flushed as one digest`);
    }
  }

  return row;
};

export default { switchCadence };
