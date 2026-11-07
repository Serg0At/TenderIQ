import notifications from '../repositories/notification.repo.js';
import subscriptions from '../repositories/channelSubscription.repo.js';
import { deliver, deliverableChannels } from './notifier.service.js';
import { logger } from '../utils/logger.js';

/**
 * Channel dispatch: which channel a name refers to, and what it does.
 *
 * This lives in `services/` rather than `libs/adapters/channel/` because
 * delivery is business logic, not transport. CLAUDE.md fixes the direction —
 * Router → Middleware → Controller → Service → Repository → Knex — so an
 * adapter must not import a service or write to a table. `libs/adapters/`
 * keeps only what genuinely wraps the third party: the Bot API client
 * (`telegram.js`), the mail port (`email/`), and the formatters.
 *
 * A channel returns 'sent', 'deferred', 'held', 'skipped' or 'failed' and never
 * throws, so one dead provider cannot abort delivery to the others. 'held' is a
 * new match waiting for a daily destination's digest — neither sent nor failed.
 *
 * **'skipped' is not a failure.** It means the organization has not switched
 * that channel on — it has no live `channel_subscriptions` row for it, which is
 * the only switch there is. Folding it into 'failed' would make every customer
 * who deliberately uses one channel look like a broken installation of the
 * other, in every metric built on this table.
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
      organizationId: notification.organization_id,
      channel: 'log',
      status: 'sent',
    });
    return 'sent';
  },
};

/**
 * Every real channel is the same object with a different name — the policy
 * engine in `notifier.service.js` is channel-generic, so there is nothing left
 * here to specialise.
 */
const transportChannel = (name) => ({
  name,
  async send(notification) {
    try {
      return await deliver(name, notification);
    } catch (error) {
      // The contract is that a channel never throws. An unexpected fault must
      // not take down the fan-out to other channels or fail the job — the
      // notification is already durable in Postgres.
      logger.error(`[${name}] delivery raised: ${error.message}`);
      return 'failed';
    }
  },
});

const CHANNELS = {
  log: logChannel,
  ...Object.fromEntries(deliverableChannels().map((name) => [name, transportChannel(name)])),
};

export const getChannel = (name) => CHANNELS[name] ?? CHANNELS.log;
export const availableChannels = () => Object.keys(CHANNELS);

/**
 * The channels an organization can actually be reached on right now.
 *
 * Used by producers that have no per-profile channel list of their own —
 * deadline reminders are raised per (org, tender), not per saved search, so
 * they have no channel list to read. It is also what an empty
 * `saved_searches.channels` resolves to, which is the honest default: naming a
 * channel the org has not configured only manufactures failed deliveries.
 *
 * `log` is always included: it is the operator's record that the alert was
 * raised at all, and it is what keeps a reminder visible when an org has linked
 * nothing. A real channel is added only when a destination is actually
 * verified, so an org without one does not accrue a failed row on every sweep.
 */
export const channelsForOrg = async (organizationId) => {
  const reachable = await Promise.all(
    deliverableChannels().map(async (channel) => {
      const linked = await subscriptions.listDeliverable({ organizationId, channel });
      return linked.length ? channel : null;
    })
  );
  return [...reachable.filter(Boolean), 'log'];
};

export default { getChannel, availableChannels, channelsForOrg };
