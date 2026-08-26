import notifications from '../repositories/notification.repo.js';
import { deliverTelegram } from '../services/notifier.service.js';
import { logger } from '../utils/logger.js';

/**
 * Send alerts that were held back by quiet hours.
 *
 * Quiet hours defer rather than drop — a supplier who asked not to be woken at
 * 3am still wants the tender at 8am, and a missed tender is the #1 churn cause.
 * The deferred `alert_deliveries` row is the durable record of that intent, and
 * this sweep is what acts on it.
 *
 * `dueDeferredDeliveries` already excludes notifications that have since been
 * delivered on this channel, so a chat that was linked twice, or an alert that
 * went out through another path, is not sent again.
 */
export const handleDeferredDeliveries = async () => {
  const due = await notifications.dueDeferredDeliveries({ channel: 'telegram', limit: 200 });
  if (!due.length) return { due: 0, sent: 0 };

  let sent = 0;
  for (const row of due) {
    const { delivery_id: deliveryId, ...notification } = row;
    try {
      // deliverTelegram writes its own alert_deliveries rows for this attempt,
      // so the deferred row is settled purely as a status change — it is the
      // record of the deferral, not a second delivery.
      const status = await deliverTelegram(notification);

      /**
       * Still quiet: the row's `deferred_until` was reached but the
       * subscription's hours were widened underneath it, so `deliverTelegram`
       * has just written a NEW deferred row carrying the new window end.
       *
       * This row must therefore be closed, or the sweep would find it due on
       * every pass and pile up a duplicate deferral each time. Settling it with
       * `deferred_until` cleared keeps the audit trail — it did happen, and it
       * was superseded — while taking it out of the queue, since the sweep
       * matches only rows that still have a due timestamp.
       */
      if (status === 'deferred') {
        await notifications.settleDeferred({
          deliveryId,
          status: 'deferred',
          detail: 'quiet window extended; superseded by a later deferral',
        });
        continue;
      }

      await notifications.settleDeferred({
        deliveryId,
        status: status === 'sent' ? 'sent' : 'failed',
        detail: status === 'sent' ? 'delivered after quiet hours' : 'retry after quiet hours failed',
      });
      if (status === 'sent') sent += 1;
    } catch (error) {
      logger.error(`[notifier] deferred delivery ${deliveryId} failed: ${error.message}`);
      await notifications.settleDeferred({
        deliveryId,
        status: 'failed',
        detail: error.message.slice(0, 500),
      });
    }
  }

  logger.info(`[notifier] deferred sweep: ${due.length} due, ${sent} sent`);
  return { due: due.length, sent };
};

export default { handleDeferredDeliveries };
