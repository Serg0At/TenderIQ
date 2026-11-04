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
 *
 * **Only a private chat can be linked.** A group or supergroup is refused, so
 * every row is one person's DM by construction. That is what makes a
 * subscription governable at all: `channel_subscriptions.user_id` can be read
 * as the owner rather than merely as whoever set it up, and no member's action
 * can silence a room shared with colleagues, because there is no shared room.
 * The invariant is global rather than a per-row flag, which is why no `personal`
 * column exists to be got wrong.
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
/**
 * Three states, not two.
 *
 * `off` is the one that used to be missing: a revoked row was filtered out of
 * the listing entirely, so switching Telegram off was indistinguishable from
 * never having linked it, and the only way back was a fresh deep link. A client
 * rendering an on/off toggle needs to see the off position.
 */
const present = (row) => ({
  id: row.id,
  channel: row.channel,
  // The chat id is the destination, not a secret, but it identifies a person's
  // account — so it is reported as a state rather than echoed back.
  status: row.revoked_at ? 'off' : row.verified_at ? 'linked' : 'pending',
  active: Boolean(row.verified_at && !row.revoked_at),
  // Set, and kept, through a revoke: it is what says this chat was once proved,
  // and therefore what makes switching it back on possible without re-linking.
  linkedAt: row.verified_at,
  revokedAt: row.revoked_at,
  failureCount: row.failure_count,
  lastError: row.last_error,
});

export const listLinks = async (organizationId) => {
  const rows = await subscriptions.listForOrg({ organizationId, channel: CHANNEL });
  return rows.map(present);
};

/**
 * Switch a previously linked chat back on — no new deep link, no second
 * `/start`.
 *
 * The `userId` is the caller's own and comes from the token; see the repository
 * for why turning ON is self-scoped while turning OFF is organization-scoped.
 */
export const enable = async ({ organizationId, userId, id }) => {
  const { row, reason } = await subscriptions.reactivate({ id, organizationId, userId });

  if (reason === 'not_found') throw ApiError.notFound('Telegram link');
  if (reason === 'never_confirmed') {
    throw ApiError.conflict(
      'This chat was never linked. Generate a connect link and open it in your chat with the bot.'
    );
  }

  return present(row);
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
const handleStart = async ({ chatId, chatType, token }) => {
  /**
   * Fails CLOSED: anything that is not explicitly `private` is refused, so a
   * missing or unrecognised type can never admit a group. `chat.type` is
   * declared in `telegramUpdateSchema` precisely so the webhook's `stripUnknown`
   * copy still carries it — without that, this branch would reject every link
   * in production while working perfectly under the polling worker.
   *
   * The token is deliberately NOT consumed here. Opening the connect link in a
   * group is an ordinary mistake, and burning the token would make the fix
   * ("open it in your own chat with the bot") fail too, with a second
   * misleading message.
   */
  if (chatType !== 'private') {
    await telegram.sendMessage({
      chatId,
      text: linkRejected(
        'Alerts are delivered to personal chats only. Open the connect link in your own chat with this bot — your link is still valid.'
      ),
    });
    return { action: 'start', result: 'not_private' };
  }

  if (!token) {
    await telegram.sendMessage({
      chatId,
      text: linkRejected('Open the connect link from Tendra to link this chat.'),
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
      text: linkRejected('That link is not valid. Generate a new one in Tendra.'),
    });
    return { action: 'start', result: 'unknown_token' };
  }

  if (pending.token_expires_at && new Date(pending.token_expires_at) < new Date()) {
    await telegram.sendMessage({
      chatId,
      text: linkRejected('That link has expired. Generate a new one in Tendra.'),
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
  const chatType = message?.chat?.type;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  if (!chatId || !text) return { action: 'ignored' };

  if (text === '/start' || text.startsWith('/start ')) {
    // Exactly one payload argument; Telegram's start parameter cannot contain
    // whitespace, so anything after the first is not ours.
    return handleStart({
      chatId,
      chatType,
      token: text.slice('/start'.length).trim().split(/\s+/)[0] || null,
    });
  }

  if (text === '/stop' || text.startsWith('/stop ')) return handleStop({ chatId });

  if (text === '/help') {
    await telegram.sendMessage({
      chatId,
      text: [
        '<b>Tendra alerts</b>',
        '',
        'This bot delivers tender alerts from Tendra.',
        'Open the connect link in Tendra to link this chat.',
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

export default { createLink, listLinks, unlink, enable, handleUpdate };
