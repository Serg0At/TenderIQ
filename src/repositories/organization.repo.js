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

    // The role's id IS its name. The one-owner partial index needs the literal
    // 'owner' in its predicate and cannot resolve a CUID, so the identifier and
    // the name are one column. ADR 0002.
    for (const [role, granted] of Object.entries(PERMISSIONS)) {
      await trx('roles').insert({ id: role }).onConflict('id').ignore();

      const wanted = granted.map((key) => idFor.get(key)).filter(Boolean);

      // Revoke first, so the role never holds a superset of the matrix — not
      // even for the width of this transaction.
      const revoke = trx('role_permissions').where({ role_id: role });
      if (wanted.length) revoke.whereNotIn('permission_id', wanted);
      await revoke.del();

      if (wanted.length) {
        await trx('role_permissions')
          .insert(wanted.map((permissionId) => ({
            id: createId(),
            role_id: role,
            permission_id: permissionId,
          })))
          .onConflict(['role_id', 'permission_id'])
          .ignore();
      }
    }
  }

  /** The role's capabilities, read back from SQL rather than the code matrix. */
  static async permissionsFor(role, trx = db) {
    const rows = await trx('role_permissions as rp')
      .join('permissions as p', 'p.id', 'rp.permission_id')
      .where('rp.role_id', role)
      .orderBy('p.key')
      .pluck('p.key');
    return rows;
  }

  static async createWithOwner({ name, type = null, userId }, trx = db) {
    const id = createId();
    await trx('organizations').insert({ id, name, type, created_by: userId });
    return id;
  }

  /**
   * Put a user in an organization at a role.
   *
   * The seeded-role check stays even though `role_id` is now the role name and
   * the foreign key would catch it: an unseeded database otherwise fails
   * registration with a driver-level constraint message that names neither the
   * role nor the fix.
   */
  static async addMember({ userId, organizationId, role }, trx = db) {
    const seeded = await trx('roles').where({ id: role }).first();
    if (!seeded) throw new Error(`[organizations] role "${role}" is not seeded`);

    const id = createId();
    await trx('memberships').insert({
      id,
      user_id: userId,
      organization_id: organizationId,
      role_id: role,
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
    // No join to `roles`: the role's name is the foreign key itself, so the join
    // could only fetch back the column already in hand.
    const query = trx('memberships as m')
      .join('organizations as o', 'o.id', 'm.organization_id')
      .where('m.user_id', userId)
      .select('m.organization_id', 'o.name as organization_name', 'm.role_id as role');

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

  /**
   * Claim the supplier party this organisation bids as.
   *
   * Deliberately a deliberate, explicit act rather than something inferred
   * from a name match. Party names in the corpus are scraped Armenian legal
   * names with inconsistent punctuation and quoting; a fuzzy auto-link would
   * eventually attach one company's win record to another company's account,
   * and the failure would be invisible — the numbers would just be wrong.
   *
   * The partial unique index refuses a party already claimed elsewhere, so the
   * conflict surfaces here as a driver error the service turns into a 409
   * rather than as two orgs quietly sharing one identity.
   */
  static async setSupplierParty(organizationId, supplierPartyId, trx = db) {
    const updated = await trx('organizations')
      .where({ id: organizationId })
      .update({ supplier_party_id: supplierPartyId });
    return updated ? trx('organizations').where({ id: organizationId }).first() : null;
  }

  static async supplierPartyFor(organizationId, trx = db) {
    const row = await trx('organizations as o')
      .leftJoin('parties as p', 'p.id', 'o.supplier_party_id')
      .where('o.id', organizationId)
      .select('o.supplier_party_id', 'p.name as supplier_name', 'p.tax_id as supplier_tax_id')
      .first();
    return row ?? null;
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
