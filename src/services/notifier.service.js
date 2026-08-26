import config from '../configs/variables.config.js';
import subscriptions from '../repositories/channelSubscription.repo.js';
import notifications from '../repositories/notification.repo.js';
import telegram from '../libs/adapters/channel/telegram.js';
import { formatNotification } from '../libs/adapters/channel/telegram.format.js';
import { logger } from '../utils/logger.js';

const { TELEGRAM } = config;

/**
 * Delivery policy: who gets an alert, when, and what is recorded about it.
 *
 * The transport adapter knows how to talk to Telegram; this knows everything
 * else. Keeping them apart is what lets quiet hours, fallback and revocation be
 * read in one file instead of being tangled into an API client.
 *
 * Two rules from the spec live here:
 *   BR-10 — respect channel preferences and quiet hours.
 *   "never lose the Notification record" — a failed or deferred send is written
 *   to `alert_deliveries` with its reason, never swallowed.
 */

/**
 * The wall-clock hour at an instant, in a named zone.
 *
 * `Intl` rather than manual offset arithmetic because Armenia is UTC+4 with no
 * DST today but the field is per-subscription and a consultant working across
 * borders will set something else. `h23` is required: `hour12: false` reports
 * midnight as 24 in some implementations, which silently breaks a window that
 * wraps midnight — exactly the common case.
 */
export const localHour = (date, timeZone) => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(date);
    return Number(parts.find((p) => p.type === 'hour').value);
  } catch {
    // An invalid timezone must not stop an alert. Treat it as "never quiet" and
    // say so once, rather than deferring every message forever.
    logger.warn(`[notifier] unknown timezone "${timeZone}", ignoring quiet hours`);
    return null;
  }
};

/**
 * Is `at` inside this subscription's quiet window?
 *
 * The window is [start, end) in local hours and may wrap midnight — 22 to 8 is
 * the setting most people actually want, and it is the one a naive
 * `start <= h && h < end` gets wrong.
 */
export const isQuiet = (subscription, at = new Date()) => {
  const { quiet_hours_start: start, quiet_hours_end: end } = subscription;
  if (start === null || start === undefined || end === null || end === undefined) return false;
  if (start === end) return false; // a zero-width window means "no quiet hours"

  const hour = localHour(at, subscription.timezone);
  if (hour === null) return false;

  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
};

/**
 * When the quiet window next ends.
 *
 * Stepped rather than computed: a closed-form answer has to reason about the
 * zone offset changing between now and the boundary, and this runs at most 192
 * times against an in-memory formatter. Correctness over cleverness for a
 * calculation that decides whether an alert is delivered at all.
 */
export const quietUntil = (subscription, from = new Date()) => {
  const STEP_MS = 15 * 60_000;
  for (let i = 1; i <= 192; i += 1) {
    const at = new Date(from.getTime() + i * STEP_MS);
    if (!isQuiet(subscription, at)) return at;
  }
  // Unreachable for any sane window; if a misconfiguration made it always
  // quiet, deliver rather than defer forever.
  return new Date(from.getTime() + 60_000);
};

/** Map a transport result onto what should happen to the subscription. */
const applyOutcome = async (subscription, result) => {
  if (result.ok) {
    await subscriptions.recordSuccess(subscription.id);
    return { status: 'sent', detail: null };
  }

  /**
   * Being throttled is not the chat's fault and must never count toward
   * revoking it. Telegram rate-limits per bot, so a burst of alerts to many
   * chats returns 429 for all of them — counting those as consecutive failures
   * would revoke every healthy subscription an org has after MAX_FAILURES.
   *
   * Deferred rather than failed, reusing the quiet-hours machinery: the sweep
   * retries it after Telegram's own `retry_after`. Same rule the scraper
   * follows for RateLimitedError — being throttled must not burn an attempt.
   */
  if (result.kind === 'throttled') {
    const seconds = result.retryAfterSeconds ?? 30;
    return {
      status: 'deferred',
      detail: `rate limited, retry after ${seconds}s`,
      deferredUntil: new Date(Date.now() + seconds * 1000),
    };
  }

  if (result.kind === 'permanent') {
    // The user blocked the bot or the chat is gone. That is an unsubscribe, not
    // an incident: revoke immediately rather than retrying something that can
    // never succeed.
    await subscriptions.revoke(subscription.id);
    logger.info(`[notifier] revoked ${subscription.channel} ${subscription.id}: ${result.detail}`);
    return { status: 'failed', detail: `revoked: ${result.detail}` };
  }

  // 'invalid' is a bug in our own message, not a bad destination — count it as
  // a failure for visibility but never let it revoke a working chat.
  if (result.kind === 'invalid') {
    logger.error(`[notifier] message rejected by ${subscription.channel}: ${result.detail}`);
    return { status: 'failed', detail: result.detail };
  }

  const outcome = await subscriptions.recordFailure({
    id: subscription.id,
    error: result.detail,
    maxFailures: TELEGRAM.MAX_FAILURES,
  });
  if (outcome?.revoked) {
    logger.warn(
      `[notifier] ${subscription.id} revoked after ${TELEGRAM.MAX_FAILURES} consecutive failures`
    );
  }
  return { status: 'failed', detail: result.detail };
};

/**
 * Deliver one notification over Telegram to every chat the org has linked.
 *
 * Returns 'sent' if at least one destination took it, 'deferred' if none did
 * but at least one is waiting on quiet hours, and 'failed' otherwise.
 *
 * The three-way answer matters: a deferred alert has not failed, it is holding
 * until morning, and reporting it as a failure makes a working night-time
 * configuration look like a broken channel in every log line and metric.
 *
 * A partial success counts as success — the supplier was reached — and each
 * destination still gets its own `alert_deliveries` row, so the detail is never
 * lost in the summary.
 */
export const deliverTelegram = async (notification, { now = new Date() } = {}) => {
  if (!telegram.isConfigured()) {
    await notifications.recordDelivery({
      notificationId: notification.id,
      channel: 'telegram',
      status: 'failed',
      detail: 'TELEGRAM_BOT_TOKEN is not set',
    });
    return 'failed';
  }

  const recipients = await subscriptions.listDeliverable({
    organizationId: notification.organization_id,
    channel: 'telegram',
  });

  if (!recipients.length) {
    // Recorded rather than skipped: "nobody has linked a chat" is the single
    // most likely reason a customer says alerts do not work, and it must be
    // visible in alert_deliveries instead of looking like nothing happened.
    await notifications.recordDelivery({
      notificationId: notification.id,
      channel: 'telegram',
      status: 'failed',
      detail: 'no linked Telegram chat for this organization',
    });
    return 'failed';
  }

  const text = formatNotification(notification, { now });
  let anySent = false;
  let anyDeferred = false;

  for (const subscription of recipients) {
    if (isQuiet(subscription, now)) {
      const until = quietUntil(subscription, now);
      await notifications.recordDelivery({
        notificationId: notification.id,
        channel: 'telegram',
        status: 'deferred',
        deferredUntil: until,
        detail: `quiet hours until ${until.toISOString()}`,
      });
      // Deferred, not dropped — the sweep in workers/notifier.js picks it up.
      anyDeferred = true;
      continue;
    }

    const result = await telegram.sendMessage({ chatId: subscription.address, text });
    const { status, detail, deferredUntil = null } = await applyOutcome(subscription, result);

    await notifications.recordDelivery({
      notificationId: notification.id,
      channel: 'telegram',
      status,
      detail,
      deferredUntil,
    });
    if (status === 'sent') anySent = true;
    if (status === 'deferred') anyDeferred = true;
  }

  if (anySent) return 'sent';
  return anyDeferred ? 'deferred' : 'failed';
};

export default { deliverTelegram, isQuiet, quietUntil, localHour };
