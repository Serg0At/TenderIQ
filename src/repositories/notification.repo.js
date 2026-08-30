import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';

/**
 * Notifications and their per-channel delivery attempts.
 *
 * The two are separate because "we decided to tell you" and "the email went
 * out" fail independently: a provider outage must not lose the notification,
 * and a retry must not create a second one.
 */
export default class NotificationRepository {
  /**
   * Create a notification unless one already exists for this
   * (organization, type, tender, subject).
   *
   * BR-9: no duplicate alert for the same tender/event to the same user. The
   * check is a read-then-insert rather than a constraint because the schema has
   * no unique key here; the matcher is single-consumer per tender, so the race
   * window is narrow, and a rare duplicate is far less costly than dropping a
   * real alert.
   *
   * `subjectId` is what the alert is about when it is NOT about a tender — a
   * vault document, today. Without it every expiring certificate in an
   * organisation would dedupe against the first one (they all carry
   * `tender_id: null`) and only one document would ever be reported. Null for
   * everything tender-shaped, so existing callers are unaffected.
   */
  static async createIfNew(
    { organizationId, userId = null, type, tenderId = null, subjectId = null, payload },
    trx = db
  ) {
    const existing = await trx('notifications')
      .where({
        organization_id: organizationId,
        type,
        tender_id: tenderId,
        subject_id: subjectId,
      })
      .first();
    if (existing) return { created: false, notification: existing };

    const id = createId();
    await trx('notifications').insert({
      id,
      organization_id: organizationId,
      user_id: userId,
      type,
      tender_id: tenderId,
      subject_id: subjectId,
      payload,
    });
    return { created: true, notification: await trx('notifications').where({ id }).first() };
  }

  /**
   * Record one delivery attempt.
   *
   * `detail` carries why a send failed or was deferred. Without it every
   * failure row reads identically, and "no chat linked" — the most common
   * cause by far — is indistinguishable from a provider outage.
   */
  static async recordDelivery(
    { notificationId, channel, status, detail = null, deferredUntil = null },
    trx = db
  ) {
    const id = createId();
    await trx('alert_deliveries').insert({
      id,
      notification_id: notificationId,
      channel,
      status,
      sent_at: status === 'sent' ? new Date() : null,
      deferred_until: deferredUntil,
      detail,
    });
    return id;
  }

  /**
   * Deliveries whose quiet window has now passed.
   *
   * The deferred row is the queue: BullMQ is not used for this because a quiet
   * window can be hours long and a delayed job holding a payload for that long
   * would be lost on a Redis flush, while the alert itself is already durable
   * in Postgres. The sweep re-reads the notification and sends it fresh.
   *
   * Joined to `notifications` because the sender needs the payload, and left
   * joined against a later 'sent' row for the same (notification, channel) so a
   * delivery that already succeeded some other way is not repeated.
   */
  static async dueDeferredDeliveries({ channel, limit = 200 }, trx = db) {
    return trx('alert_deliveries as d')
      .join('notifications as n', 'n.id', 'd.notification_id')
      .where('d.channel', channel)
      .andWhere('d.status', 'deferred')
      .andWhere('d.deferred_until', '<=', new Date())
      .whereNotExists(function sentAlready() {
        this.select('*')
          .from('alert_deliveries as s')
          .whereRaw('s.notification_id = d.notification_id')
          .andWhereRaw('s.channel = d.channel')
          .andWhere('s.status', 'sent');
      })
      .limit(limit)
      .select('d.id as delivery_id', 'n.*');
  }

  /** Close out a deferred row once the sweep has acted on it. */
  static async settleDeferred({ deliveryId, status, detail = null }, trx = db) {
    return trx('alert_deliveries')
      .where({ id: deliveryId })
      .update({
        status,
        detail,
        sent_at: status === 'sent' ? new Date() : null,
        deferred_until: null,
      });
  }

  /**
   * Matched tenders whose deadline falls inside the window and which a supplier
   * can still bid on.
   *
   * Distinct because one org can hold several matching profiles and would
   * otherwise be reminded once per profile.
   */
  static async dueForReminder({ until, from = new Date() }, trx = db) {
    return trx('notifications as n')
      .join('tenders as t', 't.id', 'n.tender_id')
      .where('n.type', 'tender-match')
      .andWhere('t.status', 'active')
      .andWhere('t.deadline_at', '>', from)
      .andWhere('t.deadline_at', '<=', until)
      .distinct('n.organization_id', 't.id as tender_id', 't.title', 't.reference_code', 't.deadline_at');
  }

  static async listForOrg(organizationId, { limit = 50 } = {}, trx = db) {
    return trx('notifications')
      .where({ organization_id: organizationId })
      // Newest first, with the id tiebreaker two notifications raised in the
      // same tick would otherwise need. Never `order by id` alone: CUID2 is not
      // sortable, so that is an arbitrary order dressed up as a feed.
      .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
      .limit(limit);
  }

  static async markRead(id, organizationId, trx = db) {
    return trx('notifications').where({ id, organization_id: organizationId }).update({ read_at: new Date() });
  }
}
