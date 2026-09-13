import { createId } from '@paralleldrive/cuid2';
import { withTransaction } from '../../libs/knex.js';
import users from '../../repositories/user.repo.js';
import organizations, { ROSTER_MEMBERS } from '../../repositories/organization.repo.js';
import AuthService from '../auth/auth.service.js';
import { roleHas, canActOn, canGrant, rolesActableBy } from '../../libs/permissions.js';
import AnnouncementService from '../../services/announcement.service.js';
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

/** A member in the roster's shape. */
const presentMember = (row) => ({
  kind: 'member',
  userId: row.user_id,
  displayName: row.display_name,
  email: row.email,
  role: row.role,
  joinedAt: row.joined_at,
});

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
    ? presentMember({ ...row, joined_at: row.at })
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

/**
 * The actor's role as the database has it now, not as their token remembers it.
 *
 * A token's role can be up to one access-token lifetime stale, which is an
 * accepted cost for reading tenders and not for deciding who may demote whom:
 * an admin demoted a minute ago must not spend those minutes changing the roles
 * of people who now outrank them. A missing membership is ROLE_FORBIDDEN — the
 * token says they manage users here, and they no longer do.
 */
export const currentMembershipOf = async ({ userId, organizationId }) => {
  const membership = await organizations.findMembership(userId, organizationId);
  if (!membership) throw ApiError.forbidden('ROLE_FORBIDDEN', { reason: 'no longer a member' });
  return membership;
};

/**
 * The member an action targets, subject to the rank rule.
 *
 * Refused as ROLE_FORBIDDEN, never NOT_FOUND, when the target exists but
 * outranks the actor: they are looking at the roster and already know this
 * person is there, so hiding it would only name the wrong problem. A target
 * who is not in this organization at all is NOT_FOUND.
 */
const targetFor = async (actorRole, organizationId, targetUserId) => {
  const target = await organizations.findMember(organizationId, targetUserId);
  if (!target) throw ApiError.notFound('Member');
  if (!canActOn(actorRole, target.role)) {
    throw new ApiError('ROLE_FORBIDDEN', {
      message: `Your role cannot act on a member whose role is ${target.role}.`,
      details: { role: actorRole, targetRole: target.role },
    });
  }
  return target;
};

/**
 * The rank rule applied to the role being handed out, not only to the member
 * receiving it. Without it an admin who may not touch another admin could still
 * make new ones — and a compromised admin account would mint the administrators
 * it cannot remove.
 */
export const assertCanGrant = (actorRole, role) => {
  if (!canGrant(actorRole, role)) {
    throw new ApiError('ROLE_FORBIDDEN', {
      message: `Your role cannot grant the ${role} role.`,
      details: { role: actorRole, grantedRole: role },
    });
  }
};

/** The sole-owner refusal, naming the way out. */
const ownerSeatConflict = (action) =>
  ApiError.conflict(
    `The owner cannot be ${action}. Transfer ownership to another member first (POST /organization/transfer-ownership).`,
    { targetRole: 'owner' }
  );

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
   * Change a member's role among the four non-owner roles.
   *
   * Gated by `user:manage` and the rank rule, and deliberately not by plan: a
   * downgraded organization must still be able to reassign its people.
   *
   * Revokes nothing. `refresh()` re-reads role and plan from the membership, so
   * the change lands within one access-token lifetime with nobody signed out —
   * signing a colleague out mid-draft to deliver a permission change is worse
   * than fifteen minutes of stale permissions.
   *
   * The owner seat is refused here as a CONFLICT naming transfer: demoting the
   * only owner would leave an organization nobody can administer, and the unique
   * index only guards against two owners, never zero.
   */
  static async changeMemberRole(actor, targetUserId, { role }) {
    const { role: actorRole, organization_name: organizationName } = await currentMembershipOf(actor);
    const target = await targetFor(actorRole, actor.organizationId, targetUserId);
    if (target.role === 'owner') throw ownerSeatConflict('given another role');
    assertCanGrant(actorRole, role);

    if (target.role !== role) {
      const changed = await organizations.updateMemberRole({
        organizationId: actor.organizationId,
        userId: target.user_id,
        role,
        actableRoles: rolesActableBy(actorRole),
      });

      if (!changed) {
        // Lost a race: re-read and give the answer that is true now.
        await targetFor(actorRole, actor.organizationId, targetUserId);
        throw ApiError.conflict('That member changed while you were editing. Reload and try again.');
      }

      await AnnouncementService.raise({
        organizationId: actor.organizationId,
        type: 'team-role-changed',
        // Every change is its own event; two changes to one person are two
        // announcements, never deduped into the first.
        subjectId: createId(),
        // Who acted — the same meaning as on every other team announcement.
        userId: actor.userId,
        payload: {
          memberUserId: target.user_id,
          memberName: target.display_name,
          role,
          previousRole: target.role,
          organizationName,
        },
      });
    }

    return presentMember(await organizations.findMember(actor.organizationId, target.user_id));
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
