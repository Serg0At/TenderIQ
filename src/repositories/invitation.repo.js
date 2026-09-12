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
