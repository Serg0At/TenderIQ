import { withTransaction } from '../../libs/knex.js';
import invitations from '../../repositories/invitation.repo.js';
import organizations from '../../repositories/organization.repo.js';
import users from '../../repositories/user.repo.js';
import AnnouncementService from '../../services/announcement.service.js';
import AuthService from '../auth/auth.service.js';
import { ApiError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

/**
 * The answer to every invite, whoever the address belongs to.
 *
 * One frozen object, returned from one place. Any difference in wording, status
 * or shape between "that person has an account" and "they do not" would make
 * this endpoint a register of who uses TenderIQ, readable by any customer on an
 * entitled plan — and two branches that each build their own response are how
 * that difference eventually appears. Nothing about the invitee is looked up
 * when sending, so there is nothing to vary it by anyway.
 */
export const INVITATION_SENT = Object.freeze({
  sent: true,
  message: 'If that person is registered, they will get the invitation.',
});

/** An invitation as the organization that sent it sees it. */
const present = (row) => ({
  id: row.id,
  email: row.email,
  role: row.role_id,
  status: row.status,
  invitedBy: row.invited_by ? { userId: row.invited_by, displayName: row.invited_by_name ?? null } : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  respondedAt: row.responded_at,
});

/** An invitation as the person it is addressed to sees it — no address, it is theirs. */
const presentOffer = (row) => ({
  id: row.id,
  organization: { id: row.organization_id, name: row.organization_name },
  role: row.role_id,
  invitedBy: row.invited_by_name ? { displayName: row.invited_by_name } : null,
  createdAt: row.created_at,
});

/** Why an offer addressed to the caller cannot be answered any more. */
const alreadyAnswered = (status) =>
  ApiError.conflict(
    status === 'accepted'
      ? 'You have already accepted that invitation.'
      : 'You have already declined that invitation. Ask for a new one to join.',
    { status }
  );

export default class InvitationService {
  /**
   * Offer an address a role in the caller's organization.
   *
   * The offer is recorded whether or not the address has an account — it is
   * matched when that address registers and verifies — and a repeat invite
   * updates the role in place. The organization is told through its existing
   * alert channels; the announcement names the role and the sender, never the
   * address.
   */
  static async send(actor, { email, role }) {
    const invitation = await invitations.upsert({
      organizationId: actor.organizationId,
      email,
      role,
      invitedBy: actor.userId,
    });

    // Both reads are about the sender's own side — nothing about the invitee.
    const [organization, inviter] = await Promise.all([
      organizations.findById(actor.organizationId),
      users.findById(actor.userId),
    ]);

    await AnnouncementService.raise({
      organizationId: actor.organizationId,
      type: 'team-invitation',
      // The invitation IS the event: re-sending it is not news a second time.
      subjectId: invitation.id,
      userId: actor.userId,
      payload: {
        invitationId: invitation.id,
        role,
        organizationName: organization?.name ?? null,
        invitedByName: inviter?.display_name ?? null,
      },
    });

    return INVITATION_SENT;
  }

  /**
   * Offers addressed to the caller, from any organization.
   *
   * Reads the address off the user row, never the request: a verified session
   * is the proof the address is theirs, and it is the only proof there is.
   */
  static async listMine(userId, { page = {} } = {}) {
    const user = await users.findById(userId);
    if (!user) throw ApiError.unauthenticated();

    const { rows, cursor, hasMore } = await invitations.listPendingForEmail(user.email, user.id, {
      limit: page.size ?? 20,
      cursor: page.cursor ?? null,
    });
    return { rows: rows.map(presentOffer), cursor, hasMore };
  }

  /**
   * Accept an offer: add a membership at the invitation's role.
   *
   * Adds, never moves. Memberships are unique per (user, organization), not per
   * user, so joining a new client leaves every existing membership exactly as
   * it was — the consultant case the enterprise plan sells. An offer from an
   * organization the caller already belongs to is a CONFLICT and stays pending:
   * accepting it cannot add a second membership, and changing their role would
   * be a role change nobody with `user:manage` made.
   *
   * What comes back depends on where the caller is working. An orgless session
   * gets a full session for the new organization, because there is nothing to
   * move away from and a blocked screen should not wait out a stale token. A
   * session already inside an organization stays there — moving tenants is
   * `switch-org`, a deliberate act — so `session` is null.
   *
   * The session is minted after the commit. If that fails, the membership
   * exists and a retry would otherwise meet "already accepted" and never get
   * the session the orgless caller was promised — so re-accepting an offer the
   * caller already accepted, and whose membership they still hold, answers as
   * the first accept did instead of a 409.
   */
  static async accept({ userId, organizationId: actingIn }, id) {
    const user = await users.findById(userId);
    if (!user) throw ApiError.unauthenticated();

    const joined = await withTransaction(async (trx) => {
      const invitation = await invitations.lockForEmail(id, user.email, trx);
      if (!invitation) throw ApiError.notFound('Invitation');

      const existing = await organizations.findMembership(user.id, invitation.organization_id, trx);
      if (invitation.status === 'accepted' && existing && !actingIn) {
        return { ...invitation, role_id: existing.role };
      }
      if (invitation.status !== 'pending') throw alreadyAnswered(invitation.status);

      if (existing) {
        throw ApiError.conflict(`You are already a member of ${invitation.organization_name}.`, {
          organizationId: invitation.organization_id,
          role: existing.role,
        });
      }

      await organizations.addMember(
        { userId: user.id, organizationId: invitation.organization_id, role: invitation.role_id },
        trx
      );
      await invitations.answer(invitation.id, 'accepted', trx);
      return invitation;
    });

    logger.info(`[invitations] user ${user.id} joined ${joined.organization_id} as ${joined.role_id}`);

    return {
      accepted: true,
      organization: { id: joined.organization_id, name: joined.organization_name },
      role: joined.role_id,
      session: actingIn ? null : await AuthService.sessionFor(user, joined.organization_id),
    };
  }

  /**
   * Decline an offer. The sender sees `declined` in their list rather than
   * silence; nothing is announced — a refusal is an answer to the sender, not
   * news for their whole company.
   */
  static async decline(userId, id) {
    const user = await users.findById(userId);
    if (!user) throw ApiError.unauthenticated();

    await withTransaction(async (trx) => {
      const invitation = await invitations.lockForEmail(id, user.email, trx);
      if (!invitation) throw ApiError.notFound('Invitation');
      if (invitation.status !== 'pending') throw alreadyAnswered(invitation.status);
      await invitations.answer(invitation.id, 'declined', trx);
    });

    return { declined: true };
  }

  /** Every offer this organization has sent, at any status. */
  static async list(organizationId, { filter = {}, page = {} } = {}) {
    const { rows, cursor, hasMore } = await invitations.listForOrg(organizationId, {
      status: filter.status ?? null,
      limit: page.size ?? 20,
      cursor: page.cursor ?? null,
    });
    return { rows: rows.map(present), cursor, hasMore };
  }

  /**
   * Withdraw an offer.
   *
   * Another organization's invitation id is NOT_FOUND, never forbidden. An
   * accepted one is a CONFLICT: the person has joined, and cancelling the
   * record of it would not remove them.
   */
  static async cancel(organizationId, id) {
    const existing = await invitations.findForOrg(id, organizationId);
    if (!existing) throw ApiError.notFound('Invitation');

    const cancelled = await invitations.cancel(id, organizationId);
    if (!cancelled) {
      // Gone in the meantime — another cancel won — is not "accepted".
      if (!(await invitations.findForOrg(id, organizationId))) throw ApiError.notFound('Invitation');
      throw ApiError.conflict(
        'That invitation has already been accepted. Remove the member instead.',
        { status: 'accepted' }
      );
    }
  }
}
