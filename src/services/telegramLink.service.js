import config from '../configs/variables.config.js';
import subscriptions from '../repositories/channelSubscription.repo.js';
import organizations from '../repositories/organization.repo.js';
import telegram from '../libs/adapters/channel/telegram.js';
import {
  linkConfirmation,
  linkRejected,
  stopConfirmation,
} from '../libs/adapters/channel/telegram.format.js';
import { ApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const { TELEGRAM } = config;
const CHANNEL = 'telegram';

/**
 * Linking a Telegram chat to an organization.
 *
 * The flow exists because of a hard constraint in the platform: a bot cannot
 * message a user who has not messaged it first. So the org cannot simply enter
 * a chat id — the chat has to introduce itself, and it has to prove which org
 * it belongs to. A one-time token carried in a `t.me/<bot>?start=<token>` deep
 * link is Telegram's own mechanism for exactly that.
 *
 * The token is the security boundary: anyone holding it can point an
 * organization's alerts at their own chat. It is 32 random bytes, single-use,
 * short-lived, and never logged.
 */

/**
 * Issue a deep link for an organization.
 *
 * The bot username must be configured, because the link cannot be built
 * without it and a link to the wrong bot fails in a way nobody can diagnose
 * from the error.
 */
export const createLink = async ({ organizationId, userId }) => {
  if (!telegram.isConfigured() || !TELEGRAM.BOT_USERNAME) {
    throw new ApiError('DEPENDENCY_UNAVAILABLE', {
      message: 'Telegram alerts are not configured on this server.',
    });
  }

  const { token } = await subscriptions.createLinkToken({
    organizationId,
    userId,
    channel: CHANNEL,
    ttlMinutes: TELEGRAM.LINK_TOKEN_TTL_MINUTES,
  });

  return {
    url: `https://t.me/${TELEGRAM.BOT_USERNAME}?start=${token}`,
    expiresInMinutes: TELEGRAM.LINK_TOKEN_TTL_MINUTES,
    // The token itself is returned so a client can render a QR code. It is not
    // logged anywhere, and it expires.
    token,
  };
};

/** What the org has linked. Pending rows included so a half-finished link is visible. */
export const listLinks = async (organizationId) => {
  const rows = await subscriptions.listForOrg({ organizationId, channel: CHANNEL });
  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    // The chat id is the destination, not a secret, but it identifies a person's
    // account — so it is reported as linked/pending rather than echoed back.
    status: row.verified_at ? 'linked' : 'pending',
    linkedAt: row.verified_at,
    quietHours:
      row.quiet_hours_start === null || row.quiet_hours_start === undefined
        ? null
        : { start: row.quiet_hours_start, end: row.quiet_hours_end, timezone: row.timezone },
    failureCount: row.failure_count,
    lastError: row.last_error,
  }));
};

/**
 * Set or clear a subscription's quiet window (BR-10).
 *
 * Here rather than in the controller because it is a tenant-scoped write with a
 * not-found rule — CLAUDE.md puts business logic in a service and forbids
 * controllers from touching the database. The repository scopes the update by
 * organization, so another tenant's id updates zero rows and reads as absent.
 */
export const setQuietHours = async ({ organizationId, id, start, end, timezone }) => {
  const updated = await subscriptions.setQuietHours({ id, organizationId, start, end, timezone });
  if (!updated) throw ApiError.notFound('Subscription');
  return {
    id,
    quietHours: start === null ? null : { start, end, timezone },
  };
};

export const unlink = async ({ organizationId, id }) => {
  const revoked = await subscriptions.revokeForOrg({ id, organizationId });
  if (!revoked) throw ApiError.notFound('Subscription');
  return { id, status: 'revoked' };
};

/**
 * Redeem a `/start <token>`.
 *
 * Every rejection path replies to the chat. A silent failure here is the worst
 * possible outcome: the user has done their part, sees nothing, and has no way
 * to tell a typo'd link from a broken integration.
 */
const handleStart = async ({ chatId, token }) => {
  if (!token) {
    await telegram.sendMessage({
      chatId,
      text: linkRejected('Open the connect link from TenderIQ to link this chat.'),
    });
    return { action: 'start', result: 'no_token' };
  }

  const pending = await subscriptions.findByToken(token);

  // Unknown and expired are answered differently on purpose: an expired token
  // is a real user whose link went stale and who needs to be told to get a new
  // one, not someone guessing.
  if (!pending) {
    await telegram.sendMessage({
      chatId,
      text: linkRejected('That link is not valid. Generate a new one in TenderIQ.'),
    });
    return { action: 'start', result: 'unknown_token' };
  }

  if (pending.token_expires_at && new Date(pending.token_expires_at) < new Date()) {
    await telegram.sendMessage({
      chatId,
      text: linkRejected('That link has expired. Generate a new one in TenderIQ.'),
    });
    return { action: 'start', result: 'expired_token' };
  }

  const confirmed = await subscriptions.confirm({ token, address: chatId });
  if (!confirmed) {
    // Lost the race with a concurrent redemption of the same token.
    await telegram.sendMessage({ chatId, text: linkRejected('That link was already used.') });
    return { action: 'start', result: 'already_used' };
  }

  const org = await organizations.findById(confirmed.organization_id);
  await telegram.sendMessage({
    chatId,
    text: linkConfirmation(org?.name ?? 'your organization'),
  });

  logger.info(`[telegram] chat linked to org ${confirmed.organization_id}`);
  return { action: 'start', result: 'linked', subscriptionId: confirmed.id };
};

/** `/stop` — an explicit unsubscribe, which BR-10 requires be honoured. */
const handleStop = async ({ chatId }) => {
  const existing = await subscriptions.findByAddress({ channel: CHANNEL, address: chatId });
  if (existing) await subscriptions.revoke(existing.id);
  await telegram.sendMessage({ chatId, text: stopConfirmation() });
  return { action: 'stop', result: existing ? 'revoked' : 'not_linked' };
};

/**
 * One inbound update.
 *
 * Everything in `update` came from the internet. Nothing is trusted: the chat
 * id is read from a fixed path and coerced, the command is matched against an
 * exact prefix rather than searched for, and unknown update types are ignored
 * rather than probed for interesting fields.
 */
export const handleUpdate = async (update) => {
  // Telegram tells us directly when a user blocks the bot — cheaper and far
  // faster than discovering it through five failed sends.
  const memberStatus = update?.my_chat_member?.new_chat_member?.status;
  if (memberStatus === 'kicked' || memberStatus === 'left') {
    const chatId = update.my_chat_member?.chat?.id;
    const existing = chatId
      ? await subscriptions.findByAddress({ channel: CHANNEL, address: chatId })
      : null;
    if (existing) {
      await subscriptions.revoke(existing.id);
      logger.info(`[telegram] chat blocked the bot; subscription ${existing.id} revoked`);
    }
    return { action: 'blocked', result: existing ? 'revoked' : 'not_linked' };
  }

  const message = update?.message;
  const chatId = message?.chat?.id;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  if (!chatId || !text) return { action: 'ignored' };

  if (text === '/start' || text.startsWith('/start ')) {
    // Exactly one payload argument; Telegram's start parameter cannot contain
    // whitespace, so anything after the first is not ours.
    return handleStart({ chatId, token: text.slice('/start'.length).trim().split(/\s+/)[0] || null });
  }

  if (text === '/stop' || text.startsWith('/stop ')) return handleStop({ chatId });

  if (text === '/help') {
    await telegram.sendMessage({
      chatId,
      text: [
        '<b>TenderIQ alerts</b>',
        '',
        'This bot delivers tender alerts from TenderIQ.',
        'Open the connect link in TenderIQ to link this chat.',
        '',
        '/stop — disconnect this chat',
      ].join('\n'),
    });
    return { action: 'help' };
  }

  // Unrecognised text. Deliberately not echoed back — the bot is one-way, and
  // replying to arbitrary input invites it being used as a relay.
  return { action: 'ignored' };
};

export default { createLink, listLinks, unlink, setQuietHours, handleUpdate };
