import { withTransaction } from '../../libs/knex.js';
import users from '../../repositories/user.repo.js';
import organizations, { ROSTER_MEMBERS } from '../../repositories/organization.repo.js';
import AuthService from '../auth/auth.service.js';
import { roleHas } from '../../libs/permissions.js';
import { ApiError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

/**
 * How many organizations one account may found.
 *
 * Creating one needs no plan and no permission, so uncapped it mints tenants —
 * each with its own vault prefix — in a loop, and the cleanup is a storage
 * purge per tenant. Three covers a consultancy plus a client or two set up by
 * hand; anything past that should be an invitation, not a new tenant.
 *
 * It counts organizations that still exist: the cost being capped is live
 * tenants, and one that has been deleted has already been purged.
 */
const MAX_CREATED_ORGANIZATIONS = 3;

/**
 * A roster entry as a client sees it.
 *
 * The roster is not only members: pending invitations join the same list for
 * people who manage users, and `kind` is how a client tells the two apart
 * without guessing from which fields are null. An invitation's `userId`,
 * `displayName` and `joinedAt` are explicitly null rather than faked — nobody
 * has joined, and there may not even be an account behind the address.
 */
const presentRosterEntry = (row) =>
  row.section === ROSTER_MEMBERS
    ? {
        kind: 'member',
        userId: row.user_id,
        displayName: row.display_name,
        email: row.email,
        role: row.role,
        joinedAt: row.at,
      }
    : {
        kind: 'invitation',
        invitationId: row.entry_id,
        userId: null,
        displayName: null,
        email: row.email,
        role: row.role,
        joinedAt: null,
        invitedAt: row.at,
      };

export default class OrganizationService {
  /**
   * Found an organization and start working inside it.
   *
   * The organization and the owner membership are one transaction: an
   * organization with no owner is one nobody can administer, invite into or
   * delete. This is meant to be the only place an organization is born;
   * `memberships_one_owner_uq`, not this method, arbitrates the owner seat.
   *
   * The cap is counted inside the same transaction with the founder's user
   * row locked. Count-then-insert without the lock is check-then-act, and four
   * parallel requests would all count two.
   *
   * Returns a full session for the new organization, minted through the same
   * choke point as login, so the founder needs no second call and no re-login
   * to use what they just made. The session is minted after the commit, since
   * `sessionFor` reads outside this transaction; if minting fails the
   * organization still exists, appears in the next login's `organizations`,
   * and `switch-org` is the way into it — a retry here would found a second.
   */
  static async create(userId, { name, type = null }) {
    const user = await users.findById(userId);
    if (!user) throw ApiError.unauthenticated();

    const organizationId = await withTransaction(async (trx) => {
      await users.lockForUpdate(user.id, trx);

      const created = await organizations.countCreatedBy(user.id, trx);
      if (created >= MAX_CREATED_ORGANIZATIONS) {
        throw new ApiError('QUOTA_EXCEEDED', {
          message: `An account can create at most ${MAX_CREATED_ORGANIZATIONS} organizations.`,
          details: { limit: MAX_CREATED_ORGANIZATIONS, created },
        });
      }

      await organizations.ensureRoles(trx);
      const id = await organizations.createWithOwner({ name, type, userId: user.id }, trx);
      await organizations.addMember({ userId: user.id, organizationId: id, role: 'owner' }, trx);
      return id;
    });

    logger.info(`[organizations] ${organizationId} created by user ${user.id}`);
    return AuthService.sessionFor(user, organizationId);
  }

  /**
   * Who is on this team, for any member of it.
   *
   * A tenant is a company, and its own staff list is not a secret from its
   * staff — so this reads at `tender:read`, not `user:manage`. Pending
   * invitations are merged in only for `user:manage` holders: an invited
   * address belongs to someone who has not joined, and a viewer must never see
   * it. The decision is made here from the role, not left to the client.
   */
  static async listMembers({ organizationId, role }, { page = {} } = {}) {
    const { rows, cursor, hasMore } = await organizations.listRoster(organizationId, {
      includeInvitations: roleHas(role, 'user:manage'),
      limit: page.size ?? 20,
      cursor: page.cursor ?? null,
    });
    return { rows: rows.map(presentRosterEntry), cursor, hasMore };
  }
}
