import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';
import { PERMISSIONS } from '../libs/permissions.js';
import subscriptions from './subscription.repo.js';

/**
 * Roster cursor: which group the last row belonged to (members, then pending
 * invitations), when it happened, and its id.
 *
 * The roster pages ASCENDING, which is the direction where millisecond
 * truncation bites: Postgres keeps microseconds and a JS Date keeps
 * milliseconds, so a cursor built from a fetched row names an instant slightly
 * EARLIER than the row itself and `>` would serve that row again. The keyset
 * therefore compares `date_trunc('milliseconds', at)`, and the ORDER BY uses the
 * same expression so the two agree about what "after" means.
 */
const encodeRosterCursor = (row) =>
  Buffer.from(`${row.section}|${new Date(row.at).toISOString()}|${row.entry_id}`).toString('base64url');

const decodeRosterCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const [section, at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const group = Number(section);
    return (group === ROSTER_MEMBERS || group === ROSTER_INVITATIONS) && id && !Number.isNaN(Date.parse(at))
      ? { section: group, at, id }
      : null;
  } catch {
    return null;
  }
};

const AT_MS = "date_trunc('milliseconds', r.at)";

/** The roster's two sections, in the order they are listed. */
export const ROSTER_MEMBERS = 0;
export const ROSTER_INVITATIONS = 1;

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

  /** `fields` lands in `organizations.type`, the column's name since before it held Fields. */
  static async createWithOwner({ name, fields = [], userId }, trx = db) {
    const id = createId();
    await trx('organizations').insert({ id, name, type: fields, created_by: userId });
    return id;
  }

  /** The organization's own settings, as its members read them. */
  static async findSettings(organizationId, trx = db) {
    return trx('organizations').where({ id: organizationId }).first('id', 'name', 'type');
  }

  /** Replace the organization's Fields. Scoped by id from the session's token, never from a path. */
  static async updateFields(organizationId, fields, trx = db) {
    const updated = await trx('organizations').where({ id: organizationId }).update({ type: fields });
    return updated > 0;
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
   * One page of an organization's roster: who is on the team now, and — for
   * callers allowed to manage users — who is about to be.
   *
   * Scoped on `organization_id` here, never by the caller — this is the query a
   * member of another tenant would need to get wrong to see this team. Removed
   * members simply are not here: removal deletes the membership, so there is no
   * status to forget to filter on (ADR 0001).
   *
   * Members come first in join order, then pending invitations in the order
   * they were sent. The group, the millisecond-truncated time and the row id
   * together are the keyset, so a page boundary can neither repeat nor drop an
   * entry. An invitation row selects NULL for user, name and joined date rather
   * than anything that could be mistaken for a person.
   */
  static async listRoster(
    organizationId,
    { includeInvitations = false, limit = 20, cursor = null } = {},
    trx = db
  ) {
    const members = trx('memberships as m')
      .join('users as u', 'u.id', 'm.user_id')
      .where('m.organization_id', organizationId)
      .select(
        trx.raw(`${ROSTER_MEMBERS} as section`),
        'm.id as entry_id',
        'm.user_id',
        'u.display_name',
        'u.email',
        'm.role_id as role',
        'm.created_at as at'
      );

    if (includeInvitations) {
      members.unionAll(function pendingInvitations() {
        this.from('invitations as i')
          .where('i.organization_id', organizationId)
          .andWhere('i.status', 'pending')
          .select(
            trx.raw(`${ROSTER_INVITATIONS} as section`),
            'i.id as entry_id',
            trx.raw('NULL as user_id'),
            trx.raw('NULL as display_name'),
            'i.email',
            'i.role_id as role',
            'i.created_at as at'
          );
      }, true);
    }

    const query = trx.from(members.as('r')).select('r.*');

    const after = decodeRosterCursor(cursor);
    if (after) {
      query.whereRaw(`(r.section, ${AT_MS}, r.entry_id) > (?, ?::timestamptz, ?)`, [
        after.section,
        after.at,
        after.id,
      ]);
    }

    // One extra row answers "is there a next page?" without a second COUNT.
    const rows = await query.orderByRaw(`r.section asc, ${AT_MS} asc, r.entry_id asc`).limit(limit + 1);

    const page = rows.slice(0, limit);
    return {
      rows: page,
      hasMore: rows.length > limit,
      cursor: page.length ? encodeRosterCursor(page[page.length - 1]) : null,
    };
  }

  /** One member of one organization, in the roster's shape. Scoped on the organization. */
  static async findMember(organizationId, userId, trx = db) {
    return trx('memberships as m')
      .join('users as u', 'u.id', 'm.user_id')
      .where('m.organization_id', organizationId)
      .andWhere('m.user_id', userId)
      .first(
        'm.user_id',
        'u.display_name',
        'u.email',
        'm.role_id as role',
        'm.created_at as joined_at'
      );
  }

  /**
   * Change a member's role, only if the member's CURRENT role is one the actor
   * may act on and is not the owner seat.
   *
   * Both conditions live in the WHERE clause rather than in a check before the
   * update, so a concurrent change — the target promoted to admin a moment ago,
   * or handed the owner seat — makes this update nothing instead of letting a
   * decision made against a stale read land. Zero rows is the caller's cue to
   * re-read and say why.
   */
  static async updateMemberRole({ organizationId, userId, role, actableRoles }, trx = db) {
    const updated = await trx('memberships')
      .where({ organization_id: organizationId, user_id: userId })
      .whereIn('role_id', actableRoles)
      .whereNot('role_id', 'owner')
      .update({ role_id: role });
    return updated > 0;
  }

  /**
   * Hand the owner seat from one member to another, inside the caller's
   * transaction.
   *
   * Demote first, then promote. `memberships_one_owner_uq` is a unique INDEX,
   * and an index cannot be deferred to commit — so promoting first would put two
   * owner rows in the organization for one statement, and the index would reject
   * the organization's own hand-off. Inside the transaction the zero-owner
   * moment between the two statements is invisible to everyone else.
   *
   * The demotion is guarded in its WHERE — it only matches while the caller
   * still holds the seat — so two concurrent transfers cannot both succeed: the
   * second blocks on the row, then finds it no longer `owner`. The promotion
   * needs no role guard, since nobody else can hold the seat while the caller
   * does. Returns which step missed, for the caller to name the problem and roll
   * back.
   *
   * `trx` is required, with no `db` default: run outside a transaction, the
   * demotion would commit on its own and a missed promotion would leave the
   * organization with no owner at all.
   */
  static async transferOwnership({ organizationId, fromUserId, toUserId }, trx) {
    const demoted = await trx('memberships')
      .where({ organization_id: organizationId, user_id: fromUserId, role_id: 'owner' })
      .update({ role_id: 'admin' });
    if (!demoted) return { ok: false, missed: 'from' };

    const promoted = await trx('memberships')
      .where({ organization_id: organizationId, user_id: toUserId })
      .update({ role_id: 'owner' });
    if (!promoted) return { ok: false, missed: 'to' };

    return { ok: true };
  }

  /**
   * End a membership: a plain DELETE, with no status left behind (ADR 0001).
   *
   * The owner seat is excluded in the WHERE, and so is any role the actor may
   * not act on, for the same reason as `updateMemberRole` — a concurrent
   * transfer or promotion must turn this into a no-op, never into deleting the
   * owner. Nothing references `memberships`, so the documents, pursuits and
   * bids the member created stay exactly where they are: with the organization.
   */
  static async deleteMembership({ organizationId, userId, actableRoles = null }, trx = db) {
    const query = trx('memberships')
      .where({ organization_id: organizationId, user_id: userId })
      .whereNot('role_id', 'owner');
    if (actableRoles) query.whereIn('role_id', actableRoles);
    return (await query.del()) > 0;
  }

  /**
   * Delete an organization, only while `ownerUserId` is its owner and its only
   * member.
   *
   * Both conditions are in the DELETE itself, not checked beforehand: an
   * invitation accepted between the service's check and this statement would
   * otherwise be cascaded away along with the tenant it just joined. Everything
   * private — vault rows, pursuits, bids, invitations, notifications, alert
   * destinations — cascades from this row.
   */
  /**
   * Hold the organization row until the transaction ends. Any insert into a
   * table with a foreign key to it — a vault document, a membership — waits
   * behind this lock, so a deletion can check what exists and be sure nothing
   * new arrives before it commits.
   */
  static async lockForUpdate(organizationId, trx) {
    return trx('organizations').where({ id: organizationId }).forUpdate().first('id');
  }

  static async deleteIfSoleOwner({ organizationId, ownerUserId }, trx = db) {
    const deleted = await trx('organizations')
      .where({ id: organizationId })
      .whereExists(function callerIsOwner() {
        this.select('*')
          .from('memberships as m')
          .whereRaw('m.organization_id = organizations.id')
          .andWhere({ 'm.user_id': ownerUserId, 'm.role_id': 'owner' });
      })
      .whereNotExists(function anyoneElse() {
        this.select('*')
          .from('memberships as m')
          .whereRaw('m.organization_id = organizations.id')
          .andWhereNot('m.user_id', ownerUserId);
      })
      .del();
    return deleted > 0;
  }

  static async countMembers(organizationId, trx = db) {
    const row = await trx('memberships').where({ organization_id: organizationId }).count('* as n').first();
    return Number(row?.n ?? 0);
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
   * One organization by id. Used by the Telegram link flow to name the org in
   * the confirmation the user sees — without it the bot can only say "your
   * organization", which is unhelpful for a consultant linked to several.
   */
  static async findById(id, trx = db) {
    if (!id) return null;
    return trx('organizations').where({ id }).first();
  }

  /**
   * Plan name for entitlement checks: the plan of the non-voided subscription
   * covering now, else 'free'.
   *
   * Read from the period's dates, never a status (ADR 0005) — it once checked
   * `status = 'active'` and no date, so a period nothing remembered to flip
   * would have granted its plan forever. No subscription is the free tier, not
   * unentitled-and-broken: the plan gate fails closed to paid features while
   * the account still works. Runs at session mint and refresh only; gate 4
   * reads the plan from the token.
   */
  static async planFor(organizationId, trx = db) {
    const row = await subscriptions.current(organizationId, trx);
    return row?.plan ?? 'free';
  }
}
