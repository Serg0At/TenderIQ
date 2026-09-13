import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';

const TABLE = 'invitations';

/**
 * Standing offers for an email address to join an organization at a role.
 *
 * Tenant-scoped like every private table: each method that serves the
 * organization's own view takes the organization id and applies it itself. The
 * one lookup that spans organizations — offers addressed to one address — keys
 * on that address, never on a bare row id.
 */

const encodeCursor = (row) =>
  Buffer.from(`${new Date(row.created_at).toISOString()}|${row.id}`).toString('base64url');

const decodeCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    return at && id && !Number.isNaN(Date.parse(at)) ? { createdAt: at, id } : null;
  } catch {
    return null;
  }
};

export default class InvitationRepository {
  /**
   * Offer an address a role, or re-offer it.
   *
   * `ON CONFLICT (organization_id, email)` is the whole idempotency story: a
   * repeat invite updates the role on the existing row, with the database
   * arbitrating rather than a read-then-write that two clicks could both pass.
   *
   * A re-invite returns a declined offer to `pending` — a decline answers one
   * offer, not all future ones — and updates a pending one's role. An
   * `accepted` row is left exactly as it is: that person has joined, their role
   * moves by role change, and the record that they accepted must not become a
   * cancellable pending offer to someone already on the team. Ending a
   * membership clears it, which is what makes a returning member invitable.
   */
  static async upsert({ organizationId, email, role, invitedBy }, trx = db) {
    const [row] = await trx(TABLE)
      .insert({
        id: createId(),
        organization_id: organizationId,
        email: String(email).toLowerCase(),
        role_id: role,
        status: 'pending',
        invited_by: invitedBy,
      })
      .onConflict(['organization_id', 'email'])
      .merge({
        role_id: role,
        status: 'pending',
        invited_by: invitedBy,
        responded_at: null,
        updated_at: trx.fn.now(),
      })
      .where(`${TABLE}.status`, '<>', 'accepted')
      .returning('*');
    // No row back means the conflict hit an accepted offer and nothing changed.
    return row ?? trx(TABLE).where({ organization_id: organizationId, email: String(email).toLowerCase() }).first();
  }

  /**
   * The offers this organization has sent, newest first.
   *
   * Descending, so the millisecond truncation of a JS Date is harmless here —
   * it can only exclude the cursor row, never repeat it.
   */
  static async listForOrg(organizationId, { status = null, limit = 20, cursor = null } = {}, trx = db) {
    const query = trx(`${TABLE} as i`)
      .leftJoin('users as u', 'u.id', 'i.invited_by')
      .where('i.organization_id', organizationId)
      .select('i.*', 'u.display_name as invited_by_name');

    if (status) query.andWhere('i.status', status);

    const after = decodeCursor(cursor);
    if (after) query.whereRaw('(i.created_at, i.id) < (?::timestamptz, ?)', [after.createdAt, after.id]);

    const rows = await query
      .orderBy([{ column: 'i.created_at', order: 'desc' }, { column: 'i.id', order: 'desc' }])
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    return {
      rows: page,
      hasMore: rows.length > limit,
      cursor: page.length ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  /**
   * Pending offers addressed to one address, across every organization.
   *
   * The only cross-tenant read in this file, and it is keyed on the address
   * rather than on anything a caller could choose: the service passes the
   * session user's own verified email, never a value from the request. That is
   * also all "matched when that address registers and verifies" needs — an
   * offer sent before the account existed has the same address on it.
   *
   * Offers from organizations `userId` already belongs to are left out: they
   * cannot be accepted (that would be a second membership), and listing them
   * would put an Accept button in front of the user that can only ever fail.
   */
  static async listPendingForEmail(email, userId, { limit = 20, cursor = null } = {}, trx = db) {
    const query = trx(`${TABLE} as i`)
      .join('organizations as o', 'o.id', 'i.organization_id')
      .leftJoin('users as u', 'u.id', 'i.invited_by')
      .where('i.email', String(email).toLowerCase())
      .andWhere('i.status', 'pending')
      .whereNotExists(function alreadyMember() {
        this.select('*')
          .from('memberships as m')
          .whereRaw('m.organization_id = i.organization_id')
          .andWhere('m.user_id', userId);
      })
      .select('i.*', 'o.name as organization_name', 'u.display_name as invited_by_name');

    const after = decodeCursor(cursor);
    if (after) query.whereRaw('(i.created_at, i.id) < (?::timestamptz, ?)', [after.createdAt, after.id]);

    const rows = await query
      .orderBy([{ column: 'i.created_at', order: 'desc' }, { column: 'i.id', order: 'desc' }])
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    return {
      rows: page,
      hasMore: rows.length > limit,
      cursor: page.length ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  /**
   * One offer addressed to this address, held until the transaction ends.
   *
   * Scoped on the email as well as the id, so an invitation id that belongs to
   * somebody else reads exactly like one that does not exist. The lock is what
   * makes a double-clicked accept add one membership rather than race two
   * inserts into the unique constraint.
   *
   * `trx` has no `db` default on purpose: outside a transaction the lock ends
   * with the statement, so calling this without one would guard nothing.
   */
  static async lockForEmail(id, email, trx) {
    return trx(`${TABLE} as i`)
      .join('organizations as o', 'o.id', 'i.organization_id')
      .where('i.id', id)
      .andWhere('i.email', String(email).toLowerCase())
      .forUpdate('i')
      .first('i.*', 'o.name as organization_name');
  }

  /** Record the invitee's answer. Only a pending offer can be answered. */
  static async answer(id, status, trx = db) {
    const updated = await trx(TABLE)
      .where({ id, status: 'pending' })
      .update({ status, responded_at: trx.fn.now(), updated_at: trx.fn.now() });
    return updated > 0;
  }

  /**
   * Forget that this address once accepted an offer from this organization.
   *
   * Called when the membership it produced ends. A re-invite leaves accepted
   * rows alone — that person has joined — so without this a removed member
   * could never be invited back: the upsert would find their old accepted row
   * and change nothing.
   */
  static async clearAccepted(organizationId, email, trx = db) {
    return trx(TABLE)
      .where({ organization_id: organizationId, email: String(email).toLowerCase(), status: 'accepted' })
      .del();
  }

  static async findForOrg(id, organizationId, trx = db) {
    return trx(TABLE).where({ id, organization_id: organizationId }).first();
  }

  /**
   * Withdraw an offer that has not been taken up.
   *
   * An accepted invitation is refused by the `whereNot`: it is the record that
   * a member joined, and deleting it would not remove them — that is a
   * different act, on a different endpoint.
   */
  static async cancel(id, organizationId, trx = db) {
    const deleted = await trx(TABLE)
      .where({ id, organization_id: organizationId })
      .whereNot('status', 'accepted')
      .del();
    return deleted > 0;
  }
}
