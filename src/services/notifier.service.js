import config from '../configs/variables.config.js';
import subscriptions from '../repositories/channelSubscription.repo.js';
import notifications from '../repositories/notification.repo.js';
import telegram from '../libs/adapters/channel/telegram.js';
import mailer from '../libs/adapters/email/index.js';
import { formatNotification as formatTelegram } from '../libs/adapters/channel/telegram.format.js';
import { formatNotification as formatEmail } from '../libs/adapters/channel/email.format.js';
import { unsubscribeUrl } from './unsubscribe.service.js';
import { DELIVERABLE_CHANNELS } from '../libs/adapters/channel/notification.present.js';
import { logger } from '../utils/logger.js';

const { TELEGRAM, EMAIL, NODE_ENV } = config;

/**
 * Delivery policy: who gets an alert, when, and what is recorded about it.
 *
 * The transports know how to talk to Telegram and to a mail server; this knows
 * everything else. Keeping them apart is what lets recipient resolution,
 * fallback and revocation be read in one file instead of being tangled into two
 * API clients that would drift.
 *
 * One engine, two channels, and that is the point. The first version of this
 * file was `deliverTelegram` — a loop over recipients with quiet hours, outcome
 * mapping and delivery recording inlined. Adding email by copying it would have
 * produced two subtly different answers to "is this deferred or failed", which
 * is the question every log line and every metric is built on. What differs
 * between channels is genuinely small and lives in `TRANSPORTS` below.
 *
 * There is no per-user preference layer and no quiet window. A channel is on
 * for an organization exactly when that organization has a live
 * `channel_subscriptions` row for it, so the subscription IS the switch and
 * there is nowhere for a second, disagreeing answer to live. Turning a channel
 * off is revoking its rows; turning it back on is linking again.
 *
 * Two rules from the spec live here:
 *   BR-9  — dedupe is upstream, in `notifications.createIfNew`.
 *   "never lose the Notification record" — a failed, deferred or skipped send is
 *   written to `alert_deliveries` with its reason, never swallowed.
 */

/**
 * RFC 2369 and RFC 8058.
 *
 * `List-Unsubscribe` is what makes a mail client show an "Unsubscribe" button
 * beside the sender's name, and `List-Unsubscribe-Post` is what lets Gmail and
 * Yahoo act on it with a single POST instead of opening a browser. Both are
 * emitted together or neither is: the second without the first means nothing,
 * and advertising one-click to a URL that cannot take a POST is worse than
 * staying silent, because the client shows the button and the recipient
 * presses spam when it fails.
 *
 * Omitted entirely when `API_BASE_URL` is unset. A wrong unsubscribe link is
 * worse than none for the same reason.
 */
const unsubscribeHeaders = (url) =>
  url
    ? {
        'List-Unsubscribe': `<${url}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      }
    : undefined;

/**
 * What is different about each channel — and it is deliberately this little.
 *
 * `revokeOnPermanent` is the one that carries real weight, and it differs for a similar reason. Telegram's 403 is
 * unambiguous — that chat blocked the bot, and no retry can ever succeed. SMTP's
 * 5xx is not: a relay refusing to send at all ("relay access denied", a sender
 * policy, an expired certificate) is reported per-recipient and looks identical
 * to a dead mailbox. Revoking on it would unsubscribe every address in the
 * system on the first misconfigured deploy, so email lets the consecutive-failure
 * counter decide instead — a genuinely dead address still gets switched off,
 * just after MAX_FAILURES attempts rather than one.
 */
const TRANSPORTS = {
  telegram: {
    name: 'telegram',
    revokeOnPermanent: true,
    maxFailures: () => TELEGRAM.MAX_FAILURES,
    // Telegram almost always supplies `retry_after`; this covers the case it does not.
    defaultRetryAfterSeconds: 30,
    isConfigured: () => telegram.isConfigured(),
    unconfiguredDetail: 'TELEGRAM_BOT_TOKEN is not set',
    channelOffDetail: 'Telegram alerts are not switched on for this organization',
    render: (notification, now) => ({ text: formatTelegram(notification, { now }) }),
    send: (subscription, message) =>
      telegram.sendMessage({ chatId: subscription.address, text: message.text }),
    // Telegram carries no unsubscribe link: `/stop` in the chat already does it,
    // in the place the person is already looking, and a link in every alert
    // would be noise in a medium where alerts are meant to be one glance.
  },

  email: {
    name: 'email',
    revokeOnPermanent: false,
    maxFailures: () => EMAIL.MAX_FAILURES,
    // SMTP greylisting has no header to read, and the convention it is built around
    // is a retry several minutes later — a 30-second retry is refused again.
    defaultRetryAfterSeconds: 300,
    isConfigured: () => mailer.isConfigured(),
    unconfiguredDetail: 'EMAIL_DRIVER=smtp but SMTP_HOST is not set',
    channelOffDetail: 'email alerts are not switched on for this organization',
    /**
     * The only rendered message that differs per recipient: its unsubscribe
     * link carries a token naming one subscription, so it cannot be shared
     * between destinations. The URL is computed once here and travels on the
     * message so the header and the visible footer link cannot disagree.
     */
    render: (notification, now, subscription) => {
      const url = unsubscribeUrl(subscription.id);
      return { ...formatEmail(notification, { now, unsubscribeUrl: url }), unsubscribeUrl: url };
    },
    send: (subscription, message) =>
      mailer.send({
        to: subscription.address,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: unsubscribeHeaders(message.unsubscribeUrl),
      }),
  },
};

/**
 * Drift between the transport table and the published channel vocabulary is a
 * silent hole, not a crash: a channel named in `DELIVERABLE_CHANNELS` with no
 * transport is one a customer can select and never be reached on, and a
 * transport missing from the list is one the deferred sweep never visits. The
 * same reasoning as queue names being constants — a typo must not be a job that
 * is quietly never picked up. Checked at import so it fails at boot, in every
 * process, rather than on the first alert of whichever kind is broken.
 */
const declared = [...DELIVERABLE_CHANNELS].sort().join(',');
const implemented = Object.keys(TRANSPORTS).sort().join(',');
if (declared !== implemented) {
  throw new Error(
    `[notifier] channel drift: DELIVERABLE_CHANNELS is [${declared}] but transports are [${implemented}]`
  );
}

export const deliverableChannels = () => [...DELIVERABLE_CHANNELS];

/** Map a transport result onto what should happen to the subscription. */
const applyOutcome = async (transport, subscription, result) => {
  if (result.ok) {
    /**
     * The `log` mail driver reports success for a message it only printed. That
     * is exactly what it is for in development, and a lie anywhere else: the
     * alert would be recorded `sent` in `alert_deliveries` while the supplier
     * was never told about the tender — the silent failure this whole table
     * exists to make impossible.
     *
     * `server.js` already refuses to boot production on this driver, and
     * `workers/index.js` now does the same. This is the second belt, and it is
     * deliberately tighter than either: it trusts nothing about NODE_ENV except
     * the one value where printing to a log is the intended behaviour. A
     * staging box that boots with the wrong driver gets honest failed rows
     * rather than a delivery report nobody can believe.
     *
     * Returned before the failure counter, like `auth` below: this is a
     * misconfiguration, and burning a subscription's attempts for it would
     * revoke every address in the system while the address itself was fine.
     */
    if (result.kind === 'logged' && NODE_ENV !== 'development') {
      logger.error(
        `[notifier] EMAIL_DRIVER=log in NODE_ENV=${NODE_ENV} — alert written to the log, not delivered`
      );
      return {
        status: 'failed',
        detail: 'channel misconfigured: EMAIL_DRIVER=log writes to the log and sends nothing',
      };
    }

    await subscriptions.recordSuccess(subscription.id);
    return { status: 'sent', detail: null };
  }

  /**
   * Being throttled is not the recipient's fault and must never count toward
   * revoking them. Telegram rate-limits per bot, so a burst of alerts to many
   * chats returns 429 for all of them — counting those as consecutive failures
   * would revoke every healthy subscription an org has after MAX_FAILURES. SMTP
   * greylisting (4xx) is the same shape: a deliberate "ask me again shortly".
   *
   * Deferred rather than failed, reusing the quiet-hours machinery: the sweep
   * retries it after the provider's own `retry_after`. Same rule the scraper
   * follows for RateLimitedError — being throttled must not burn an attempt.
   */
  if (result.kind === 'throttled') {
    const seconds = result.retryAfterSeconds ?? transport.defaultRetryAfterSeconds;
    return {
      status: 'deferred',
      detail: `rate limited, retry after ${seconds}s`,
      deferredUntil: new Date(Date.now() + seconds * 1000),
    };
  }

  if (result.kind === 'permanent' && transport.revokeOnPermanent) {
    // The user blocked the bot or the chat is gone. That is an unsubscribe, not
    // an incident: revoke immediately rather than retrying something that can
    // never succeed.
    await subscriptions.revoke(subscription.id);
    logger.info(`[notifier] revoked ${subscription.channel} ${subscription.id}: ${result.detail}`);
    return { status: 'failed', detail: `revoked: ${result.detail}` };
  }

  // 'invalid' is a bug in our own message, not a bad destination — count it as
  // a failure for visibility but never let it revoke a working recipient.
  if (result.kind === 'invalid') {
    logger.error(`[notifier] message rejected by ${subscription.channel}: ${result.detail}`);
    return { status: 'failed', detail: result.detail };
  }

  /**
   * Bad SMTP credentials. Every send will fail identically until a human edits
   * the config, so this must not burn the failure counter: otherwise one wrong
   * password revokes every email subscription in the system within an hour, and
   * fixing the password does not bring them back.
   */
  if (result.kind === 'auth') {
    logger.error(`[notifier] ${subscription.channel} authentication failed: ${result.detail}`);
    return { status: 'failed', detail: `channel misconfigured: ${result.detail}` };
  }

  const outcome = await subscriptions.recordFailure({
    id: subscription.id,
    error: result.detail,
    maxFailures: transport.maxFailures(),
  });
  if (outcome?.revoked) {
    logger.warn(
      `[notifier] ${subscription.id} revoked after ${transport.maxFailures()} consecutive failures`
    );
  }
  return { status: 'failed', detail: result.detail };
};

/**
 * Deliver one notification over one channel, to every destination the org has.
 *
 * Returns 'sent' if at least one destination took it, 'deferred' if none did but
 * at least one is waiting, 'skipped' if the organization has not switched this
 * channel on, and 'failed' otherwise.
 *
 * The four-way answer matters. A deferred alert has not failed, it is holding
 * until the provider will take it; a skipped one has not failed either, the
 * organization simply does not use this channel. Reporting either as a failure
 * makes a working configuration look like a broken channel in every log line and
 * metric — which is how a real outage stops being visible.
 *
 * A partial success counts as success — the supplier was reached — and each
 * destination still gets its own `alert_deliveries` row, so the detail is never
 * lost in the summary.
 */
export const deliver = async (channel, notification, { now = new Date() } = {}) => {
  const transport = TRANSPORTS[channel];
  if (!transport) throw new Error(`[notifier] no transport for channel "${channel}"`);

  // A row names its destination only when it went to one; the unconfigured and
  // no-destination rows below pass none.
  const record = (fields) =>
    notifications.recordDelivery({
      notificationId: notification.id,
      organizationId: notification.organization_id,
      channel,
      ...fields,
    });

  if (!transport.isConfigured()) {
    await record({ status: 'failed', detail: transport.unconfiguredDetail });
    return 'failed';
  }

  const recipients = await subscriptions.listDeliverable({
    organizationId: notification.organization_id,
    channel,
  });

  /**
   * No live subscription IS the organization switching this channel off — it is
   * the only switch there is — so this is 'skipped', not 'failed'. Recording it
   * as a failure would make every org that deliberately uses one channel look
   * like a broken installation of the other, in every metric built on this
   * table. It is still written with its reason, because "alerts do not work" is
   * a support question and this row is the honest answer to it.
   */
  if (!recipients.length) {
    await record({ status: 'skipped', detail: transport.channelOffDetail });
    return 'skipped';
  }

  let anySent = false;
  let anyDeferred = false;

  for (const subscription of recipients) {
    /**
     * Rendered inside the loop, not hoisted above it, because an email's
     * unsubscribe token belongs to one subscription and must never appear in
     * another recipient's copy. Telegram rebuilds an identical string each
     * time; that is pure string building next to a network round trip, and
     * paying it buys the guarantee that no per-recipient secret can leak
     * sideways through a shared object.
     */
    const message = transport.render(notification, now, subscription);
    const result = await transport.send(subscription, message);
    const { status, detail, deferredUntil = null } = await applyOutcome(
      transport,
      subscription,
      result
    );

    await record({ subscriptionId: subscription.id, status, detail, deferredUntil });
    if (status === 'sent') anySent = true;
    if (status === 'deferred') anyDeferred = true;
  }

  if (anySent) return 'sent';
  if (anyDeferred) return 'deferred';
  return 'failed';
};

export default { deliver, deliverableChannels };
