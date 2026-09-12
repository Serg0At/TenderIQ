import crypto from 'crypto';
import config from '../configs/variables.config.js';
import subscriptions from '../repositories/channelSubscription.repo.js';
import { ApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const { AUTH, APP } = config;

/**
 * Switching a channel off from inside the message itself, with no login.
 *
 * The authenticated way to do this already exists — `DELETE /integrations/email/:id`
 * and `DELETE /integrations/telegram/:id` — and it stays the way a customer
 * manages alerts. This is for the other case: a person holding an email, in a
 * mail client, who wants it to stop now. Mail clients show an "Unsubscribe"
 * button when the message declares where it points, and the honest reason to
 * build one is self-interested rather than polite. Without it the annoyed
 * recipient presses the spam button instead, and mail providers score a sending
 * domain on how often that happens — enough of them and every TenderIQ message
 * lands in junk, password resets included. The unsubscribe link protects the
 * password resets.
 *
 * It only ever switches a channel OFF. There is no token that turns one on:
 * this link travels through mail relays, spam filters, corporate archives and
 * forwarded threads, so the worst thing anyone who finds one can do must be
 * "these alerts stop" — which is the effect the link is for. Turning a channel
 * back on requires logging in, where the address can be proved again.
 */

/**
 * The token is derived, not stored.
 *
 * An `unsubscribe_token` column would be a second secret to migrate, rotate and
 * leak; an HMAC over the subscription id needs no schema change and no lookup
 * before verification. The same reasoning `authStore.js` applies to reset codes.
 *
 * The `unsubscribe:` prefix is domain separation and is not decorative. This
 * secret also signs access tokens and reset-code digests, and without a prefix
 * naming the purpose, a digest minted in one context is a digest valid in
 * another — the classic way a signing key gets reused into a vulnerability.
 */
const digest = (subscriptionId) =>
  crypto
    .createHmac('sha256', AUTH.JWT_ACCESS_SECRET ?? '')
    .update(`unsubscribe:${subscriptionId}`)
    .digest('hex');

/** Compare two digests without leaking, through timing, how far they matched. */
const digestsMatch = (a, b) => {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
};

/**
 * `base64url` because this goes in a URL in an email: a mail client may wrap,
 * requote or percent-encode a line, and the base64url alphabet is the one that
 * survives all three untouched.
 */
export const mintToken = (subscriptionId) =>
  Buffer.from(`${subscriptionId}.${digest(subscriptionId)}`, 'utf8').toString('base64url');

/**
 * The subscription a token names, or null.
 *
 * Null covers every failure — malformed, wrong signature, unknown row — and
 * deliberately does not distinguish them. A caller that could tell "no such
 * subscription" from "bad signature" is an oracle for guessing ids, and the
 * person clicking the link cannot act on the difference anyway.
 */
const resolve = async (token) => {
  if (!token || typeof token !== 'string') return null;

  let decoded;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const separator = decoded.lastIndexOf('.');
  if (separator <= 0) return null;

  const id = decoded.slice(0, separator);
  const signature = decoded.slice(separator + 1);
  if (!digestsMatch(signature, digest(id))) return null;

  return (await subscriptions.findById(id)) ?? null;
};

/** Enough to recognise your own address, not enough to learn someone else's. */
const maskAddress = (channel, address) => {
  const value = String(address ?? '');
  if (channel !== 'email') return 'your linked Telegram chat';

  const at = value.lastIndexOf('@');
  if (at <= 0) return 'your address';
  return `${value[0]}${'•'.repeat(Math.max(value.slice(1, at).length, 1))}${value.slice(at)}`;
};

/**
 * What this token WOULD switch off. Reads; never writes.
 *
 * This split is the whole reason `GET` and `POST` behave differently. Corporate
 * mail security scanners open every URL in every message before the recipient
 * sees it, and a GET that unsubscribed on sight would silently switch alerts
 * off for the customers whose employers scan hardest. The reset-code flow
 * already avoids link-following for the same reason.
 */
export const preview = async (token) => {
  const subscription = await resolve(token);
  if (!subscription) throw ApiError.notFound('Unsubscribe link');

  return {
    channel: subscription.channel,
    address: maskAddress(subscription.channel, subscription.address),
    active: !subscription.revoked_at,
  };
};

/**
 * Switch it off.
 *
 * Idempotent, and that is a requirement rather than a nicety: a mail client may
 * retry a one-click unsubscribe, a person may click twice, and an archived
 * message keeps working forever. A second call reports the same success as the
 * first — an error page would tell someone their unsubscribe failed at the exact
 * moment it had already worked.
 */
export const revoke = async (token) => {
  const subscription = await resolve(token);
  if (!subscription) throw ApiError.notFound('Unsubscribe link');

  if (!subscription.revoked_at) {
    await subscriptions.revoke(subscription.id);
    logger.info(`[unsubscribe] ${subscription.channel} subscription ${subscription.id} revoked from a message link`);
  }

  return {
    channel: subscription.channel,
    address: maskAddress(subscription.channel, subscription.address),
    status: 'revoked',
  };
};

/**
 * The link that goes in the message, or null when this server does not know its
 * own public address.
 *
 * Null rather than a relative or guessed URL: a wrong unsubscribe link is worse
 * than none, because the mail client still shows the button and the recipient
 * still presses spam when it fails.
 */
export const unsubscribeUrl = (subscriptionId) => {
  if (!APP.API_BASE_URL) return null;
  return `${APP.API_BASE_URL.replace(/\/+$/, '')}/api/v1/unsubscribe?token=${mintToken(subscriptionId)}`;
};

export default { mintToken, preview, revoke, unsubscribeUrl };
