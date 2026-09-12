import subscriptions from '../repositories/channelSubscription.repo.js';
import users from '../repositories/user.repo.js';
import mailer from '../libs/adapters/email/index.js';
import { ApiError } from '../utils/errors.js';

const CHANNEL = 'email';

/**
 * Switching email alerts on and off for an organization.
 *
 * The counterpart to `telegramLink.service.js`, and deliberately the same shape:
 * a `channel_subscriptions` row IS the switch, so there is no preference table
 * and no `alert_channels` column that could disagree with it. An organization
 * "uses email" exactly when it has a live row here.
 *
 * Email needs no link-token dance. That flow exists because a Telegram bot
 * cannot open a conversation and the chat id is unknowable until the user
 * messages first; a member's own address is already proven — `email_verified_at`
 * was set by the verification link before they could log in at all. Mailing a
 * second confirmation would be theatre, and theatre that fails silently when it
 * lands in a spam folder.
 *
 * That reasoning covers the member's OWN address and nothing else. A shared
 * `alerts@company.am` has no verified owner, and adding one here would let an
 * organization point its alerts at a mailbox nobody consented to — that address
 * would need `createLinkToken` + `confirm`, exactly as Telegram does.
 */
/**
 * Three states, not two — `off` is a revoked row, which the listing now keeps.
 * Switching a channel off has never deleted anything; hiding the row simply
 * made it look that way, and left a client with no id to switch back on.
 */
const present = (row) => ({
  id: row.id,
  channel: row.channel,
  address: row.address,
  status: row.revoked_at ? 'off' : row.verified_at ? 'active' : 'pending',
  active: Boolean(row.verified_at && !row.revoked_at),
  linkedAt: row.verified_at,
  revokedAt: row.revoked_at,
  failureCount: row.failure_count,
  lastError: row.last_error,
});

export const list = async (organizationId) => {
  const rows = await subscriptions.listForOrg({ organizationId, channel: CHANNEL });
  return rows.map(present);
};

/**
 * Switch a previously confirmed address back on by id.
 *
 * `POST /integrations/email` covers the other case — a member who has no row at
 * all — by creating or reviving one from their own verified address. This one
 * exists so a client can render the same on/off toggle for both channels and
 * flip it with the id it already has.
 */
export const enable = async ({ organizationId, userId, id }) => {
  const { row, reason } = await subscriptions.reactivate({ id, organizationId, userId });

  if (reason === 'not_found') throw ApiError.notFound('Subscription');
  if (reason === 'never_confirmed') {
    throw ApiError.conflict('This address was never confirmed. Switch email alerts on to create it.');
  }

  return present(row);
};

/**
 * Subscribe the caller's own account address.
 *
 * There is no address parameter, and that is the access control: the only thing
 * this endpoint can ever subscribe is the address on the authenticated user's
 * own row, so no request shape can aim an organization's alerts somewhere else.
 *
 * `createVerified` revives a revoked row rather than inserting a second one —
 * `channel_subscriptions_live_uq` covers only live rows, so an insert after a
 * revoke would succeed and leave two histories for one destination.
 */
export const subscribe = async ({ organizationId, userId }) => {
  if (!mailer.isConfigured()) {
    throw new ApiError('DEPENDENCY_UNAVAILABLE', {
      message: 'Email alerts are not configured on this server.',
    });
  }

  const user = await users.findById(userId);
  // Unreachable through the API — the token would not authenticate — but the
  // alternative to checking is subscribing `undefined` as an address.
  if (!user?.email) throw ApiError.notFound('User');
  if (!user.email_verified_at) {
    throw ApiError.forbidden('EMAIL_UNVERIFIED', {
      message: 'Confirm your email address before switching on email alerts.',
    });
  }

  const row = await subscriptions.createVerified({
    organizationId,
    userId,
    channel: CHANNEL,
    address: user.email,
  });

  return { id: row.id, channel: CHANNEL, address: row.address, status: 'active' };
};

/** Tenant-scoped revoke — another org's id simply is not found. */
export const unsubscribe = async ({ organizationId, id }) => {
  const revoked = await subscriptions.revokeForOrg({ id, organizationId });
  if (!revoked) throw ApiError.notFound('Subscription');
  return { id, status: 'revoked' };
};

export default { list, subscribe, unsubscribe, enable };
