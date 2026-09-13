import { createId } from '@paralleldrive/cuid2';
import { withTransaction } from '../../libs/knex.js';
import users from '../../repositories/user.repo.js';
import invitations from '../../repositories/invitation.repo.js';
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

/** The owner-seat refusal for a role change, naming the way out. */
const ownerSeatConflict = (action) =>
  ApiError.conflict(
    `The owner cannot be ${action}. Transfer ownership to another member first (POST /organization/transfer-ownership).`,
    { targetRole: 'owner' }
  );

/**
 * The owner-seat refusal for ending the owner's membership, by removal or by
 * leaving. Which way out is real depends on who else is here: with other
 * members, transfer the seat; alone, delete the organization — there is nobody
 * to transfer it to.
 */
const ownerCannotGo = async (organizationId, action) => {
  const otherMembers = (await organizations.countMembers(organizationId)) - 1;
  return ApiError.conflict(
    otherMembers > 0
      ? `The owner cannot ${action}. Transfer ownership to another member first (POST /organization/transfer-ownership).`
      : `The owner is the only member and cannot ${action}. Delete the organization instead (DELETE /organization).`,
    { role: 'owner', otherMembers }
  );
};

/**
 * End one membership: delete it and forget the accepted invitation behind it,
 * in one transaction; then, outside it, announce and revoke.
 *
 * Shared by removal and leaving, which differ in who may do it and in nothing
 * that happens afterwards. The order after the commit is deliberate. The
 * announcement goes first because it cannot be retried — a second attempt at
 * the removal finds no member and answers 404. The session revoke goes last and
 * is logged rather than thrown: `refresh()` already refuses a token whose
 * membership is gone, so a Redis failure here costs hygiene, and turning it into
 * a 500 would report a removal that happened as one that failed.
 *
 * Returns false when the guarded delete matched nothing.
 */
const endMembership = async ({ organizationId, user, actableRoles = null, announce = null }) => {
  const ended = await withTransaction(async (trx) => {
    const deleted = await organizations.deleteMembership(
      { organizationId, userId: user.id, actableRoles },
      trx
    );
    if (deleted) await invitations.clearAccepted(organizationId, user.email, trx);
    return deleted;
  });
  if (!ended) return false;

  if (announce) await AnnouncementService.raise(announce);

  try {
    await AuthService.revokeOrganizationSessions(user.id, organizationId);
  } catch (error) {
    logger.error(`[organizations] session revoke for ${user.id} in ${organizationId} failed: ${error.message}`);
  }
  return true;
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
   * Remove a member from the organization.
   *
   * `user:manage` plus the rank rule, and not plan-gated: gating the shrink
   * direction would leave a downgraded customer paying again to close an access
   * hole. Its own endpoint, never a branch of leaving — leaving needs no
   * permission, and one handler asking "is this me" is how a viewer eventually
   * discovers they can remove people.
   *
   * After the delete: that organization's refresh families are revoked (and
   * only that organization's — the person's other memberships keep working),
   * and an organization-wide announcement is raised. The removed member's alert
   * destinations are deliberately left alone, so that announcement reaches them
   * too; with no tombstone it is the only thing that will ever tell them which
   * organization removed them. An owner revokes those destinations separately.
   */
  static async removeMember(actor, targetUserId) {
    const { role: actorRole, organization_name: organizationName } = await currentMembershipOf(actor);
    const target = await targetFor(actorRole, actor.organizationId, targetUserId);
    if (target.role === 'owner') throw await ownerCannotGo(actor.organizationId, 'be removed');

    const removed = await endMembership({
      organizationId: actor.organizationId,
      user: { id: target.user_id, email: target.email },
      actableRoles: rolesActableBy(actorRole),
      announce: {
        organizationId: actor.organizationId,
        type: 'team-member-removed',
        subjectId: createId(),
        userId: actor.userId,
        payload: {
          memberUserId: target.user_id,
          memberName: target.display_name,
          organizationName,
        },
      },
    });

    if (!removed) {
      // Lost a race — already gone, promoted past the actor, or made owner.
      await targetFor(actorRole, actor.organizationId, targetUserId);
      throw ApiError.conflict('That member changed while you were editing. Reload and try again.');
    }

    logger.info(`[organizations] user ${target.user_id} removed from ${actor.organizationId} by ${actor.userId}`);
  }

  /**
   * Leave an organization: your own membership, so no permission at all.
   *
   * The one exception is the owner. Leaving would strand an organization with
   * no owner, which nobody could administer, so it is refused with the way out:
   * transfer the seat when anyone else is here, or delete the organization when
   * nobody is. Leaving never deletes anything itself — the one call that needs
   * no permission must not be the most destructive one in the API.
   *
   * The caller's session in this organization is over, so the response carries
   * a fresh one: their first remaining membership, or the orgless state if this
   * was their last.
   */
  static async leave(actor) {
    const membership = await organizations.findMembership(actor.userId, actor.organizationId);
    if (!membership) throw ApiError.notFound('Membership');
    if (membership.role === 'owner') throw await ownerCannotGo(actor.organizationId, 'leave');

    const user = await users.findById(actor.userId);
    if (!user) throw ApiError.unauthenticated();

    const left = await endMembership({ organizationId: actor.organizationId, user });
    if (!left) {
      // Removed a moment ago (404), or promoted to owner in the meantime (409).
      const now = await organizations.findMembership(user.id, actor.organizationId);
      if (!now) throw ApiError.notFound('Membership');
      throw await ownerCannotGo(actor.organizationId, 'leave');
    }

    logger.info(`[organizations] user ${user.id} left ${actor.organizationId}`);
    return {
      left: true,
      organization: { id: actor.organizationId, name: membership.organization_name },
      session: await AuthService.sessionFor(user, null),
    };
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
