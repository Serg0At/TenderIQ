import invitations from '../../repositories/invitation.repo.js';
import organizations from '../../repositories/organization.repo.js';
import users from '../../repositories/user.repo.js';
import AnnouncementService from '../../services/announcement.service.js';
import { ApiError } from '../../utils/errors.js';

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
