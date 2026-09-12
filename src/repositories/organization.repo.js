import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';
import { PERMISSIONS } from '../libs/permissions.js';

/**
 * Roster cursor: the join time and membership id of the last row served.
 *
 * The roster pages ASCENDING, which is the direction where millisecond
 * truncation bites: Postgres keeps microseconds and a JS Date keeps
 * milliseconds, so a cursor built from a fetched row names an instant slightly
 * EARLIER than the row itself and `>` would serve that row again. The keyset
 * therefore compares `date_trunc('milliseconds', created_at)`, and the ORDER BY
 * uses the same expression so the two agree about what "after" means.
 */
const encodeRosterCursor = (row) =>
  Buffer.from(`${new Date(row.joined_at).toISOString()}|${row.membership_id}`).toString('base64url');

const decodeRosterCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    return at && id && !Number.isNaN(Date.parse(at)) ? { joinedAt: at, id } : null;
  } catch {
    return null;
  }
};

const JOINED_AT_MS = "date_trunc('milliseconds', m.created_at)";

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
   * With no organization named, the choice has to be deterministic — a login
   * that lands a consultant in a different client on every sign-in is a
   * session that moves tenants under them — so it is the membership joined
   * first, not "whichever row Postgres returns first". Joined order rather than
   * name, so founding or joining another organization never changes where the
   * next login lands.
   */
  static async findMembership(userId, organizationId = null, trx = db) {
    // No join to `roles`: the role's name is the foreign key itself, so the join
    // could only fetch back the column already in hand.
    const query = trx('memberships as m')
      .join('organizations as o', 'o.id', 'm.organization_id')
      .where('m.user_id', userId)
      .select('m.organization_id', 'o.name as organization_name', 'm.role_id as role')
      .orderBy([{ column: 'm.created_at' }, { column: 'm.organization_id' }]);

    if (organizationId) query.andWhere('m.organization_id', organizationId);
    return query.first();
  }

  /**
   * Every organization this user can act in, for the session response.
   *
   * A client cannot offer "switch to…" without it, and the ids are what
   * `POST /auth/switch-org` takes. Same ordering as `findMembership`, so the
   * organization a login lands in is the first one in this list.
   */
  static async listMembershipsFor(userId, trx = db) {
    return trx('memberships as m')
      .join('organizations as o', 'o.id', 'm.organization_id')
      .where('m.user_id', userId)
      .select('o.id', 'o.name', 'm.role_id as role')
      .orderBy([{ column: 'm.created_at' }, { column: 'o.id' }]);
  }

  /**
   * One page of an organization's roster: who is on the team now.
   *
   * Scoped on `organization_id` here, never by the caller — this is the query a
   * member of another tenant would need to get wrong to see this team. Removed
   * members simply are not here: removal deletes the membership, so there is no
   * status to forget to filter on (ADR 0001).
   *
   * Ordered by when each person joined, oldest first, with the membership id as
   * the tiebreaker, so a page boundary can neither repeat nor drop a member.
   */
  static async listMembers(organizationId, { limit = 20, cursor = null } = {}, trx = db) {
    const query = trx('memberships as m')
      .join('users as u', 'u.id', 'm.user_id')
      .where('m.organization_id', organizationId)
      .select(
        'm.id as membership_id',
        'm.user_id',
        'u.display_name',
        'u.email',
        'm.role_id as role',
        'm.created_at as joined_at'
      );

    const after = decodeRosterCursor(cursor);
    if (after) {
      query.whereRaw(`(${JOINED_AT_MS}, m.id) > (?::timestamptz, ?)`, [after.joinedAt, after.id]);
    }

    // One extra row answers "is there a next page?" without a second COUNT.
    const rows = await query
      .orderByRaw(`${JOINED_AT_MS} asc, m.id asc`)
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    return {
      rows: page,
      hasMore: rows.length > limit,
      cursor: page.length ? encodeRosterCursor(page[page.length - 1]) : null,
    };
  }

  /**
   * How many organizations this user has founded and that still exist.
   *
   * Reads `created_by`, not ownership: a founder who transferred the owner
   * seat away still spent one of their creations, or the cap is a loop of
   * create-and-hand-off.
   */
  static async countCreatedBy(userId, trx = db) {
    const row = await trx('organizations').where({ created_by: userId }).count('* as n').first();
    return Number(row?.n ?? 0);
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
