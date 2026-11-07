import crypto from 'crypto';
import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';

const TABLE = 'channel_subscriptions';

/**
 * The cadence a new destination starts at, per channel: a Telegram message is a
 * glance, so a chat stays instant; a mailbox suits one morning digest. Set here,
 * where destinations are created, because the column has no database default —
 * a channel missing from this table inserts NULL and the NOT NULL refuses it,
 * rather than every forgotten case silently becoming instant.
 */
const NEW_DESTINATION_CADENCE = { telegram: 'instant', email: 'daily' };

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
      cadence: NEW_DESTINATION_CADENCE[channel],
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
   * Subscribe an address whose ownership is already proven, with no token round trip.
   *
   * The link-token dance exists because a Telegram bot cannot open a
   * conversation: the only way to learn a chat id is for the user to message
   * first. Email has no such problem, and for the member's *own* account address
   * there is nothing left to prove — `users.email_verified_at` was set by the
   * verification link before they could log in at all. Mailing a second
   * confirmation to an address the system already verified is theatre, and it
   * is theatre with a failure mode: an alert channel that silently never
   * activates because the confirmation landed in a spam folder.
   *
   * This is emphatically NOT for an arbitrary address someone types in. A shared
   * `alerts@company.am` has no verified owner and must go through
   * `createLinkToken` + `confirm`, or the endpoint becomes a way to point an
   * organization's alerts at a mailbox nobody consented to.
   *
   * Re-subscribing revives the existing row rather than inserting a second one:
   * `channel_subscriptions_live_uq` covers only live rows, so an insert after a
   * revoke would succeed and leave two histories for one destination.
   */
  static async createVerified({ organizationId, userId, channel, address }, trx = db) {
    const existing = await trx(TABLE)
      .where({ organization_id: organizationId, channel, address: String(address) })
      .first();

    if (existing) {
      const [row] = await trx(TABLE)
        .where({ id: existing.id })
        .update({
          user_id: userId,
          verified_at: existing.verified_at ?? new Date(),
          revoked_at: null,
          link_token: null,
          token_expires_at: null,
          failure_count: 0,
          last_error: null,
          updated_at: new Date(),
        })
        .returning('*');
      return row;
    }

    const [row] = await trx(TABLE)
      .insert({
        id: createId(),
        organization_id: organizationId,
        user_id: userId,
        channel,
        cadence: NEW_DESTINATION_CADENCE[channel],
        address: String(address),
        verified_at: new Date(),
      })
      .returning('*');
    return row;
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

  /**
   * One destination, only if it can be delivered to right now — verified, with
   * an address, not revoked. The digest's check at send time: a destination
   * switched off between the morning job and its own digest job receives
   * nothing. Not organization-scoped: the caller is a worker holding an id the
   * morning job read from this table.
   */
  static async findDeliverable(id, trx = db) {
    if (!id) return null;
    return trx(TABLE)
      .where({ id })
      .whereNotNull('address')
      .whereNotNull('verified_at')
      .whereNull('revoked_at')
      .first();
  }

  /**
   * Tenant-scoped listing for the API. Pending AND revoked rows included.
   *
   * Revoked rows used to be filtered out here, which quietly made switching a
   * channel off look like deleting it: the row survived in the table, but the
   * API stopped mentioning it, so a client had no way to render "off" and no
   * way to learn the id needed to switch it back on. Turning Telegram on again
   * meant generating a fresh deep link and re-opening it in the chat — repeating
   * a proof of ownership that the surviving row already held.
   *
   * So the list reports the whole history of destinations for this org, and the
   * caller says which are live. Active first: an off row is a footnote, not the
   * headline.
   */
  static async listForOrg({ organizationId, channel = null }, trx = db) {
    const query = trx(TABLE).where({ organization_id: organizationId });
    if (channel) query.andWhere({ channel });
    return query.orderBy([
      // NULLs (live rows) sort first under Postgres's default for DESC... which
      // is NULLS FIRST, so this is stated explicitly rather than relied upon.
      { column: 'revoked_at', order: 'asc', nulls: 'first' },
      { column: 'created_at', order: 'desc' },
      { column: 'id', order: 'desc' },
    ]);
  }

  /**
   * One subscription by id, revoked ones included.
   *
   * Deliberately NOT organization-scoped, and one of only two reads here that
   * are not. The caller is the unsubscribe link in a delivered message: whoever
   * holds it has no session and no organization to scope by — they have a token
   * that names exactly one row, and proving they may act on that row is the
   * token's job, done before this is ever called. Scoping by an org id the
   * caller supplied would be worse than no scoping, since the caller would be
   * asserting their own tenant.
   *
   * Revoked rows are returned so an unsubscribe can be idempotent: clicking the
   * link twice must report the same success, not "not found".
   *
   * The row this returns is never handed to a client as-is. It carries a chat
   * id or an address, and the unsubscribe surface masks both.
   */
  static async findById(id, trx = db) {
    if (!id) return null;
    return trx(TABLE).where({ id }).first();
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

  /**
   * Switch a destination that was turned off back on, without re-proving it.
   *
   * The row still holds everything that made it deliverable — the address, and
   * the `verified_at` that says someone once proved they own it. Revoking never
   * erased any of that; it set one timestamp. So turning it back on is clearing
   * that timestamp, not repeating the link dance. For Telegram that is the whole
   * point: the chat id is only knowable because the user messaged the bot once,
   * and making them do it again to undo their own click is a tax on changing
   * their mind.
   *
   * **Scoped to the caller's OWN subscription, unlike revoking.** That asymmetry
   * is deliberate. Switching someone's alerts off is safe; switching them ON
   * starts sending messages to a private chat or a personal inbox, and the
   * person who turned it off may have been the recipient saying "stop" — through
   * `/stop`, or the unsubscribe link in a message. A colleague with
   * `savedsearch:write` must not be able to overrule that. Every row is one
   * person's own destination now that only private chats can be linked, so
   * "your own" is well defined.
   *
   * Refuses a row that was never confirmed: a pending link has no address, so
   * there is nothing to reactivate and the honest answer is to finish linking.
   * The failure counter is reset because a destination that was auto-revoked
   * after repeated failures is being given a genuine second chance — carrying
   * the old count over would revoke it again on the first hiccup.
   */
  static async reactivate({ id, organizationId, userId }, trx = db) {
    const existing = await trx(TABLE)
      .where({ id, organization_id: organizationId, user_id: userId })
      .first();

    if (!existing) return { row: null, reason: 'not_found' };
    if (!existing.address || !existing.verified_at) return { row: null, reason: 'never_confirmed' };

    // Already on: report success rather than an error. A toggle that is pressed
    // twice, or two tabs saving at once, must not produce a failure for a state
    // the caller was asking for anyway.
    if (!existing.revoked_at) return { row: existing, reason: 'already_active' };

    const [row] = await trx(TABLE)
      .where({ id })
      .update({ revoked_at: null, failure_count: 0, last_error: null, updated_at: new Date() })
      .returning('*');

    return { row, reason: 'reactivated' };
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

  /** Housekeeping: pending links nobody redeemed. */
  static async purgeExpiredTokens(trx = db) {
    return trx(TABLE)
      .whereNotNull('link_token')
      .andWhere('token_expires_at', '<', new Date())
      .del();
  }
}
