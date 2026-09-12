import notifications from '../repositories/notification.repo.js';
import { alertsQueue } from '../queues/index.js';
import { JOB, PRIORITY } from '../queues/names.js';
import { logger } from '../utils/logger.js';

/**
 * Organization-wide announcements about the team: an invitation sent, a role
 * changed, a member removed.
 *
 * Organization-wide is not a style choice. Delivery resolves destinations by
 * organization and channel and ignores `notifications.user_id`, so whatever is
 * raised here reaches every linked destination in the tenant — which is why
 * the wording lives in `teamAnnouncement` and is always third person.
 * Per-recipient delivery would have to be built before anything could be
 * addressed to one person.
 *
 * The notification row is written synchronously and the delivery is queued:
 * the request that changed the team must not wait on Telegram or SMTP, and a
 * throttled provider needs the retry semantics a job has. Raising is
 * best-effort from the caller's point of view — the change it announces has
 * already committed, and failing that request because Redis is unavailable
 * would report a removal as failed when it happened.
 */
export default class AnnouncementService {
  /**
   * @param subjectId What the announcement is about. It is the dedupe key
   *   (`notifications_dedupe_uq`), so it must identify one EVENT: an
   *   invitation id announces that invitation once, however often it is
   *   re-sent; a role change needs an id of its own per change.
   */
  static async raise({ organizationId, type, subjectId, userId = null, payload }) {
    try {
      const { created, notification } = await notifications.createIfNew({
        organizationId,
        userId,
        type,
        subjectId,
        payload,
      });

      /**
       * An existing notification is normally already delivered, and raising it
       * again must not announce the event twice. The exception is one that was
       * recorded but never reached delivery — the queue was unavailable the
       * first time — which the dedupe index would otherwise strand forever:
       * every retry would read "already raised" and return. So it is queued
       * again exactly when it has no delivery attempt on record.
       */
      if (!created && (await notifications.hasDeliveries(notification.id))) {
        return { raised: false };
      }

      await alertsQueue.add(
        JOB.DELIVER_NOTIFICATION,
        { notificationId: notification.id },
        // A hyphen, not a colon: BullMQ refuses a custom id containing ':' unless
        // it splits into exactly three parts, and the refusal is a thrown error
        // that the catch below would turn into a silently undelivered alert.
        { priority: PRIORITY.LIVE, jobId: `notify-${notification.id}` }
      );
      return { raised: created, notificationId: notification.id };
    } catch (error) {
      logger.error(`[announcement] ${type} for org ${organizationId} not raised: ${error.message}`);
      return { raised: false };
    }
  }
}
