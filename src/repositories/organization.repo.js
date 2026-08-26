import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';
import { PERMISSIONS } from '../libs/permissions.js';

/**
 * Organizations, the roles that can be held in them, and who holds what.
 *
 * The organization is the tenant boundary: every private table hangs off it,
 * and a token carries exactly one, so a request can never span two.
 */
export default class OrganizationRepository {
  /**
   * Project the code matrix onto `roles`, `permissions` and `role_permissions`.
   *
   * `memberships.role_id` is a foreign key, so a role row must exist before
   * anyone can join an org. Idempotent and called on registration rather than
   * left as a deploy step, because a forgotten seed would make sign-up fail in
   * production with a foreign-key error and no obvious cause.
   *
   * `libs/permissions.js` stays authoritative — these tables exist to satisfy
   * the constraint and to let the permission set be joined and inspected in
   * SQL. `authorize` still answers from the code matrix, so a stale row here
   * cannot grant anything.
   *
   * Reconciles rather than only inserts. The old `text[]` column got revocation
   * for free — writing the whole array replaced it — so a permission deleted
   * from the matrix disappeared on the next run. A join table has to say that
   * out loud, or a capability removed from the code stays granted in the
   * database forever.
   */
  static async ensureRoles(trx = db) {
    const keys = [...new Set(Object.values(PERMISSIONS).flat())].sort();

    await trx('permissions')
      .insert(keys.map((key) => ({ id: createId(), key })))
      .onConflict('key')
      .ignore();

    const idFor = new Map(
      (await trx('permissions').whereIn('key', keys).select('id', 'key')).map((row) => [
        row.key,
        row.id,
      ])
    );

    for (const [name, granted] of Object.entries(PERMISSIONS)) {
      await trx('roles').insert({ id: createId(), name }).onConflict('name').ignore();
      const role = await trx('roles').where({ name }).first();

      const wanted = granted.map((key) => idFor.get(key)).filter(Boolean);

      // Revoke first, so the role never holds a superset of the matrix — not
      // even for the width of this transaction.
      const revoke = trx('role_permissions').where({ role_id: role.id });
      if (wanted.length) revoke.whereNotIn('permission_id', wanted);
      await revoke.del();

      if (wanted.length) {
        await trx('role_permissions')
          .insert(wanted.map((permissionId) => ({
            id: createId(),
            role_id: role.id,
            permission_id: permissionId,
          })))
          .onConflict(['role_id', 'permission_id'])
          .ignore();
      }
    }
  }

  /** The role's capabilities, read back from SQL rather than the code matrix. */
  static async permissionsFor(roleName, trx = db) {
    const rows = await trx('role_permissions as rp')
      .join('roles as r', 'r.id', 'rp.role_id')
      .join('permissions as p', 'p.id', 'rp.permission_id')
      .where('r.name', roleName)
      .orderBy('p.key')
      .pluck('p.key');
    return rows;
  }

  static async createWithOwner({ name, type = null, userId }, trx = db) {
    const id = createId();
    await trx('organizations').insert({ id, name, type, created_by: userId });
    return id;
  }

  static async addMember({ userId, organizationId, roleName }, trx = db) {
    const role = await trx('roles').where({ name: roleName }).first();
    if (!role) throw new Error(`[organizations] role "${roleName}" is not seeded`);

    const id = createId();
    await trx('memberships').insert({
      id,
      user_id: userId,
      organization_id: organizationId,
      role_id: role.id,
    });
    return id;
  }

  /**
   * The membership a token is minted from: which org, and in what role.
   *
   * Returns the first membership; multi-org (the consultant case) will need an
   * explicit organization argument, which is why this takes one optionally.
   */
  static async findMembership(userId, organizationId = null, trx = db) {
    const query = trx('memberships as m')
      .join('roles as r', 'r.id', 'm.role_id')
      .join('organizations as o', 'o.id', 'm.organization_id')
      .where('m.user_id', userId)
      .select('m.organization_id', 'o.name as organization_name', 'r.name as role');

    if (organizationId) query.andWhere('m.organization_id', organizationId);
    return query.first();
  }

  /**
   * Plan name for entitlement checks, defaulting to 'free'.
   *
   * An organization with no subscription row is on the free tier, not
   * unentitled-and-broken — the plan gate must fail closed to paid features
   * while still letting the account work.
   */
  /**
   * One organization by id. Used by the Telegram link flow to name the org in
   * the confirmation the user sees — without it the bot can only say "your
   * organization", which is unhelpful for a consultant linked to several.
   */
  static async findById(id, trx = db) {
    if (!id) return null;
    return trx('organizations').where({ id }).first();
  }

  static async planFor(organizationId, trx = db) {
    const row = await trx('subscriptions as s')
      .join('plans as p', 'p.id', 's.plan_id')
      .where('s.organization_id', organizationId)
      .andWhere('s.status', 'active')
      .select('p.name')
      .first();
    return row?.name ?? 'free';
  }
}
