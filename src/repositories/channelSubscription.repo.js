import crypto from 'crypto';
import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';

const TABLE = 'channel_subscriptions';

/**
 * Where an organization's alerts are delivered.
 *
 * One row is one destination on one channel — a Telegram chat, later an email
 * address. The lifecycle is the reason this is a table: a Telegram bot cannot
 * open a conversation, so a subscription starts as a pending token, becomes
 * verified when the user messages the bot, and can be revoked from either side.
 *
 * Tenant isolation is enforced here, not by callers: every read that a request
 * can reach takes an `organizationId` and filters on it.
 */
export default class ChannelSubscriptionRepository {
  /**
   * Start a link: a pending row carrying a one-time token.
   *
   * The token is 32 bytes of CSPRNG output, base64url. It is a bearer secret —
   * whoever holds it can point an organization's alerts at their own chat — so
   * it must not be a CUID2 or anything else derived from a counter or clock.
   *
   * `url-safe` matters concretely: the token travels in a `t.me/<bot>?start=`
   * parameter, and Telegram's deep-link payload accepts only [A-Za-z0-9_-].
   */
  static async createLinkToken(
    { organizationId, userId = null, channel = 'telegram', ttlMinutes = 30 },
    trx = db
  ) {
    const token = crypto.randomBytes(32).toString('base64url');
    const id = createId();

    await trx(TABLE).insert({
      id,
      organization_id: organizationId,
      user_id: userId,
      channel,
      link_token: token,
      token_expires_at: new Date(Date.now() + ttlMinutes * 60_000),
    });

    return { id, token };
  }

  /**
   * Resolve a token from an inbound message.
   *
   * Deliberately does NOT filter on expiry: an expired token must produce
   * "that link has expired" rather than the same "unknown link" a forged token
   * gets, or a user whose link sat in a chat overnight has no idea why it
   * failed. The caller distinguishes; see `confirm`.
   */
  static async findByToken(token, trx = db) {
    if (!token) return null;
    return trx(TABLE).where({ link_token: token }).first();
  }

  /**
   * Confirm a pending link against the chat that presented the token.
   *
   * The token is cleared on success, which is what makes it single-use: a
   * second `/start` with the same payload finds nothing. Doing it in the same
   * UPDATE as the address — and requiring `link_token` still to match — means
   * two concurrent redemptions cannot both succeed, since the second updates
   * zero rows.
   */
  static async confirm({ token, address }, trx = db) {
    const updated = await trx(TABLE)
      .where({ link_token: token })
      .update({
        address: String(address),
        link_token: null,
        token_expires_at: null,
        verified_at: new Date(),
        revoked_at: null,
        failure_count: 0,
        last_error: null,
        updated_at: new Date(),
      })
      .returning('*');

    return updated[0] ?? null;
  }

  /**
   * Every destination that should receive this org's alerts on this channel.
   *
   * Verified and not revoked — a pending link has no address to send to, and a
   * revoked one asked to stop.
   */
  static async listDeliverable({ organizationId, channel }, trx = db) {
    return trx(TABLE)
      .where({ organization_id: organizationId, channel })
      .whereNotNull('address')
      .whereNotNull('verified_at')
      .whereNull('revoked_at')
      .select('*');
  }

  /** Tenant-scoped listing for the API, pending rows included so a user can see one is waiting. */
  static async listForOrg({ organizationId, channel = null }, trx = db) {
    const query = trx(TABLE).where({ organization_id: organizationId }).whereNull('revoked_at');
    if (channel) query.andWhere({ channel });
    return query.orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]);
  }

  /**
   * Find a live subscription by its channel address.
   *
   * The inbound path — /stop, or Telegram reporting the bot was blocked —
   * knows only a chat id, so this is the one lookup that cannot be scoped by
   * organization. It is exact-match on an indexed column and returns a row the
   * caller only ever revokes, never exposes.
   */
  static async findByAddress({ channel, address }, trx = db) {
    return trx(TABLE)
      .where({ channel, address: String(address) })
      .whereNull('revoked_at')
      .first();
  }

  static async revoke(id, trx = db) {
    return trx(TABLE)
      .where({ id })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date(), updated_at: new Date() });
  }

  /** Tenant-scoped revoke for the API — another org's id simply is not found. */
  static async revokeForOrg({ id, organizationId }, trx = db) {
    return trx(TABLE)
      .where({ id, organization_id: organizationId })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date(), updated_at: new Date() });
  }

  /**
   * Record a send outcome against the destination.
   *
   * The counter is what turns a chat that has quietly stopped working into one
   * that is switched off: `maxFailures` consecutive failures revoke it, and any
   * success resets to zero so an outage does not accumulate toward revocation
   * across weeks.
   */
  static async recordFailure({ id, error, maxFailures = 5 }, trx = db) {
    const [row] = await trx(TABLE)
      .where({ id })
      .increment('failure_count', 1)
      .update({ last_error: String(error ?? '').slice(0, 500), updated_at: new Date() })
      .returning(['id', 'failure_count']);

    if (row && row.failure_count >= maxFailures) {
      await ChannelSubscriptionRepository.revoke(id, trx);
      return { ...row, revoked: true };
    }
    return { ...row, revoked: false };
  }

  static async recordSuccess(id, trx = db) {
    return trx(TABLE)
      .where({ id })
      .whereNot({ failure_count: 0 })
      .update({ failure_count: 0, last_error: null, updated_at: new Date() });
  }

  static async setQuietHours({ id, organizationId, start, end, timezone }, trx = db) {
    return trx(TABLE)
      .where({ id, organization_id: organizationId })
      .update({
        quiet_hours_start: start,
        quiet_hours_end: end,
        ...(timezone ? { timezone } : {}),
        updated_at: new Date(),
      });
  }

  /** Housekeeping: pending links nobody redeemed. */
  static async purgeExpiredTokens(trx = db) {
    return trx(TABLE)
      .whereNotNull('link_token')
      .andWhere('token_expires_at', '<', new Date())
      .del();
  }
}
