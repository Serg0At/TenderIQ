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
   * BR-9: no duplicate alert for the same tender/event to the same user. The read
   * is the fast path, but the arbiter is `notifications_dedupe_uq` — the read alone
   * was a check against nothing, and two sweeps raising the same alert in the same
   * tick both saw "no existing row" and both inserted. `ON CONFLICT DO NOTHING`
   * makes the loser of that race read back the winner's row instead of throwing:
   * a unique violation here is the constraint doing its job, the same way it is on
   * ingestion, and a worker must not die mid-sweep over one.
   *
   * The index is NULLS NOT DISTINCT because every row has a NULL in the key — see
   * the note in `migrations/create_table.js`.
   *
   * `subjectId` is what the alert is about when it is NOT about a tender — a
   * vault document, an invitation. Without it every expiring certificate in an
   * organisation would dedupe against the first one (they all carry
   * `tender_id: null`) and only one document would ever be reported. On an
   * `amendment` it is the tender's version (`v{n}`), so each amendment is its
   * own event. Null for everything else tender-shaped.
   */
  static async createIfNew(
    { organizationId, userId = null, type, tenderId = null, subjectId = null, payload },
    trx = db
  ) {
    const key = {
      organization_id: organizationId,
      type,
      tender_id: tenderId,
      subject_id: subjectId,
    };

    const existing = await trx('notifications').where(key).first();
    if (existing) return { created: false, notification: existing };

    const [notification] = await trx('notifications')
      .insert({ id: createId(), ...key, user_id: userId, payload })
      .onConflict(['organization_id', 'type', 'tender_id', 'subject_id'])
      .ignore()
      .returning('*');

    if (notification) return { created: true, notification };

    // Nothing came back: another worker inserted between the read and the write.
    // Its row is the notification, and this caller must be told `created: false`
    // so it does not deliver a second copy of an alert already being sent.
    const winner = await trx('notifications').where(key).first();
    if (winner) return { created: false, notification: winner };

    /**
     * Conflicted against a row that is not there. Nothing deletes notifications, so
     * this means the index and this query disagree about what the dedupe key IS —
     * add a column to one and not the other and every alert of that shape lands
     * here. Returning `created: false` would be the worst possible answer: every
     * caller reads that as "already told them" and drops the alert with no error
     * and no log. Throw, so the sweep retries and a real drift is loud.
     */
    throw new Error(
      `notifications_dedupe_uq rejected an insert whose dedupe key ${JSON.stringify(key)} matches no row — ` +
        'the unique index and createIfNew disagree on the key'
    );
  }

  /**
   * Record one delivery attempt.
   *
   * `detail` carries why a send failed or was deferred. Without it every
   * failure row reads identically, and "no chat linked" — the most common
   * cause by far — is indistinguishable from a provider outage.
   *
   * `subscriptionId` names the destination the attempt went to, and is null
   * only for a row that went to none (a channel with no live destination, an
   * unconfigured channel, the `log` channel). `organizationId` is the
   * notification's own: the composite keys refuse a row whose notification or
   * destination belongs to another organization.
   */
  static async recordDelivery(
    {
      notificationId,
      organizationId,
      subscriptionId = null,
      channel,
      status,
      detail = null,
      deferredUntil = null,
    },
    trx = db
  ) {
    const id = createId();
    await trx('alert_deliveries').insert({
      id,
      notification_id: notificationId,
      organization_id: organizationId,
      channel_subscription_id: subscriptionId,
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

  /** Whether any channel has recorded an attempt at this notification, in any outcome. */
  static async hasDeliveries(notificationId, trx = db) {
    const row = await trx('alert_deliveries').where({ notification_id: notificationId }).first('id');
    return Boolean(row);
  }

  /** One notification by id, for a delivery job that carries only the id. */
  static async findById(id, trx = db) {
    return trx('notifications').where({ id }).first();
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
