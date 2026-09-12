import notifications from '../repositories/notification.repo.js';
import { deliver, deliverableChannels } from '../services/notifier.service.js';
import { logger } from '../utils/logger.js';

/**
 * Send alerts that a throttled provider held back.
 *
 * Deferral is what keeps being rate-limited from costing a customer an alert: a
 * 429 is not the recipient's fault and must never burn an attempt, so the send
 * is parked with the provider's own `retry_after` rather than failed. The
 * deferred `alert_deliveries` row is the durable record of that, and this sweep
 * is what acts on it. A missed tender is the #1 churn cause.
 *
 * **It sweeps every deliverable channel, not just Telegram.** This used to name
 * `'telegram'` twice — once in the query and once in the call — which was
 * invisible while there was one channel and would have been a silent hole the
 * day there were two: an email deferred to morning would have sat in the table
 * until someone went looking. The channel list comes from the same place the
 * dispatcher gets it, so adding a channel cannot forget this file.
 *
 * `dueDeferredDeliveries` already excludes notifications that have since been
 * delivered on that channel, so a destination that was linked twice, or an alert
 * that went out through another path, is not sent again.
 */
export const handleDeferredDeliveries = async () => {
  let due = 0;
  let sent = 0;

  for (const channel of deliverableChannels()) {
    const rows = await notifications.dueDeferredDeliveries({ channel, limit: 200 });
    if (!rows.length) continue;
    due += rows.length;

    for (const row of rows) {
      const { delivery_id: deliveryId, ...notification } = row;
      try {
        // `deliver` writes its own alert_deliveries rows for this attempt, so
        // the deferred row is settled purely as a status change — it is the
        // record of the deferral, not a second delivery.
        const status = await deliver(channel, notification);

        /**
         * Still deferred: the row came due, but the provider throttled us
         * again, so `deliver` has just written a NEW deferred row carrying the
         * new retry time.
         *
         * This row must therefore be closed, or the sweep would find it due on
         * every pass and pile up a duplicate deferral each time. Settling it
         * with `deferred_until` cleared keeps the audit trail — it did happen,
         * and it was superseded — while taking it out of the queue, since the
         * sweep matches only rows that still have a due timestamp.
         */
        if (status === 'deferred') {
          await notifications.settleDeferred({
            deliveryId,
            status: 'deferred',
            detail: 'throttled again; superseded by a later deferral',
          });
          continue;
        }

        /**
         * The organization switched this channel off while the alert was
         * waiting — its last subscription was revoked. Settling it as 'skipped'
         * rather than 'failed' keeps the distinction the whole four-way status
         * vocabulary exists for: nobody was let down here.
         */
        if (status === 'skipped') {
          await notifications.settleDeferred({
            deliveryId,
            status: 'skipped',
            detail: 'channel switched off before the deferral cleared',
          });
          continue;
        }

        await notifications.settleDeferred({
          deliveryId,
          status: status === 'sent' ? 'sent' : 'failed',
          detail: status === 'sent' ? 'delivered after deferral' : 'retry after deferral failed',
        });
        if (status === 'sent') sent += 1;
      } catch (error) {
        logger.error(`[notifier] deferred ${channel} delivery ${deliveryId} failed: ${error.message}`);
        await notifications.settleDeferred({
          deliveryId,
          status: 'failed',
          detail: error.message.slice(0, 500),
        });
      }
    }
  }

  if (due) logger.info(`[notifier] deferred sweep: ${due} due, ${sent} sent`);
  return { due, sent };
};

export default { handleDeferredDeliveries };
