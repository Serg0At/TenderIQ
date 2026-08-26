import notifications from '../repositories/notification.repo.js';
import subscriptions from '../repositories/channelSubscription.repo.js';
import { deliverTelegram } from './notifier.service.js';
import { logger } from '../utils/logger.js';

/**
 * Channel dispatch: which channel a name refers to, and what it does.
 *
 * This lives in `services/` rather than `libs/adapters/channel/` because
 * delivery is business logic, not transport. CLAUDE.md fixes the direction —
 * Router → Middleware → Controller → Service → Repository → Knex — so an
 * adapter must not import a service or write to a table. `libs/adapters/`
 * keeps only what genuinely wraps the third party: the Bot API client
 * (`telegram.js`) and the message formatter (`telegram.format.js`).
 *
 * A channel returns 'sent', 'deferred' or 'failed' and never throws, so one
 * dead provider cannot abort delivery to the others.
 *
 * **A channel records its own `alert_deliveries` rows, and callers must not.**
 * Telegram fans one notification out to every chat an org has linked, so the
 * honest record is one row per destination; a caller adding an aggregate row on
 * top produced N+1 rows per alert and logged a deferred message as a failure.
 * Only the channel knows how many sends it actually made.
 */

const logChannel = {
  name: 'log',
  async send(notification) {
    logger.info(
      `[alert] org=${notification.organization_id} type=${notification.type} ` +
        `tender=${notification.tender_id} :: ${notification.payload?.title ?? ''}`
    );
    await notifications.recordDelivery({
      notificationId: notification.id,
      channel: 'log',
      status: 'sent',
    });
    return 'sent';
  },
};

const telegramChannel = {
  name: 'telegram',
  async send(notification) {
    try {
      return await deliverTelegram(notification);
    } catch (error) {
      // The contract is that a channel never throws. An unexpected fault must
      // not take down the fan-out to other channels or fail the job — the
      // notification is already durable in Postgres.
      logger.error(`[telegram] delivery raised: ${error.message}`);
      return 'failed';
    }
  },
};

const unimplemented = (name) => ({
  name,
  async send(notification) {
    // Recorded as a real failed delivery rather than silently skipped, so the
    // gap shows up in alert_deliveries instead of looking like success.
    await notifications.recordDelivery({
      notificationId: notification.id,
      channel: name,
      status: 'failed',
      detail: `${name} channel is not implemented`,
    });
    return 'failed';
  },
});

const CHANNELS = {
  log: logChannel,
  telegram: telegramChannel,
  email: unimplemented('email'),
  viber: unimplemented('viber'),
};

export const getChannel = (name) => CHANNELS[name] ?? CHANNELS.log;
export const availableChannels = () => Object.keys(CHANNELS);

/**
 * The channels an organization can actually be reached on right now.
 *
 * Used by producers that have no per-profile channel list of their own —
 * deadline reminders are raised per (org, tender), not per saved search, so
 * they have nothing to read a preference from.
 *
 * `log` is always included: it is the operator's record that the alert was
 * raised at all, and it is what keeps a reminder visible when an org has
 * linked nothing. Telegram is added only when a chat is actually linked, so an
 * org without one does not accrue a failed row on every reminder.
 */
export const channelsForOrg = async (organizationId) => {
  const linked = await subscriptions.listDeliverable({ organizationId, channel: 'telegram' });
  return linked.length ? ['telegram', 'log'] : ['log'];
};

export default { getChannel, availableChannels, channelsForOrg };
