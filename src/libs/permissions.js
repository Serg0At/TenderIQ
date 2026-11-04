/**
 * The role → permission matrix, transcribed from security/Role Permissions.md.
 *
 * Kept as data in one file so an authorization question has exactly one answer.
 * Scattering role checks through controllers is how a `viewer` eventually ends
 * up able to write a bid on one forgotten endpoint.
 */
export const PERMISSIONS = {
  owner: [
    'org:manage', 'user:manage', 'billing:manage',
    'tender:read', 'intelligence:read',
    'savedsearch:write', 'trackedtender:write', 'bid:write',
    'vault:write', 'vault:read', 'report:export',
  ],
  admin: [
    'org:manage', 'user:manage',
    'tender:read', 'intelligence:read',
    'savedsearch:write', 'trackedtender:write', 'bid:write',
    'vault:write', 'vault:read', 'report:export',
  ],
  coordinator: [
    'tender:read', 'intelligence:read',
    'savedsearch:write', 'trackedtender:write', 'bid:write',
    'vault:write', 'vault:read', 'report:export',
  ],
  // Read-only by design: no :write permission of any kind.
  viewer: ['tender:read', 'intelligence:read', 'vault:read'],
  // Byte-identical to coordinator ON PURPOSE: the role is a label recording that
  // the member is external, which the roster and a future audit log both want.
  // There is no `client:switch` — choosing which of your own memberships to act
  // under is not an act inside a tenant, so `POST /auth/switch-org` checks no
  // permission. Do not "fix" the duplication; a divergence needs a stated reason.
  consultant: [
    'tender:read', 'intelligence:read',
    'savedsearch:write', 'trackedtender:write', 'bid:write',
    'vault:write', 'vault:read', 'report:export',
  ],
};

export const ROLES = Object.keys(PERMISSIONS);

/**
 * Every role that can be handed out: all but owner.
 *
 * There is exactly one owner seat per organization and it moves only by
 * transfer (ADR 0002), so neither an invitation nor a role change may name it.
 */
export const ASSIGNABLE_ROLES = ROLES.filter((role) => role !== 'owner');

/**
 * Who may act on whom, beyond holding `user:manage`.
 *
 * `owner` and `admin` both hold that permission, so without a rank an admin can
 * evict the owner who pays the bill, or a compromised admin can clear out the
 * other admins. The rule: the owner acts on anyone; everyone else acts only on
 * roles strictly below their own — so an admin manages coordinators, viewers
 * and consultants, and never another admin or the owner. The three working
 * roles share a rank; none of them holds `user:manage` anyway.
 */
const RANK = { owner: 3, admin: 2, coordinator: 1, viewer: 1, consultant: 1 };

export const canActOn = (actorRole, targetRole) =>
  actorRole === 'owner' || (RANK[actorRole] ?? 0) > (RANK[targetRole] ?? Number.POSITIVE_INFINITY);

/**
 * The same rule for the role being handed out: an actor may grant only roles
 * they could then act on. The owner may make an admin; an admin may not, or the
 * rule that stops an admin removing other admins would not stop them creating
 * more of them. `owner` is never grantable at all — it moves by transfer.
 */
export const canGrant = (actorRole, role) => role !== 'owner' && canActOn(actorRole, role);

/** The target roles an actor may act on — for putting the rank rule inside a WHERE clause. */
export const rolesActableBy = (actorRole) => ROLES.filter((role) => canActOn(actorRole, role));

/**
 * Permissions — or named features — that need an entitled plan on top of the
 * role.
 *
 * A plan downgrade must remove intelligence for every role including owner,
 * so this is checked separately from the matrix rather than folded into it.
 *
 * `invitations` is a feature key, not a permission, because the permission it
 * rides on is shared: `user:manage` also covers removal, role change and
 * transfer, and gating those would leave a downgraded customer with no way to
 * remove an ex-employee except paying again. Gating the growth direction sells
 * the plan; gating the shrink direction holds access hostage. So the invite
 * route names this key explicitly (`authorize('user:manage', { planGate })`)
 * and nothing else is affected. `pro`, not `business`: a whole price step in
 * front of adding one colleague is where people share a login instead.
 */
export const PLAN_GATED = {
  'intelligence:read': ['pro', 'business', 'enterprise'],
  invitations: ['pro', 'business', 'enterprise'],
  // The relevant list rides on `tender:read`, which every plan has for the plain
  // list, so — like invitations — it is gated by feature key, not permission.
  relevance: ['pro', 'business', 'enterprise'],
};

/**
 * Checklist generations an organization may request per calendar month (Yerevan) of its
 * current subscription. Code, not configuration: changing a number is a reviewed decision.
 * A trial gets less than paid Pro, whatever plan it grants. A plan with no entry is 0, so a
 * plan added without a number fails closed.
 */
export const CHECKLIST_QUOTA = Object.freeze({
  free: 0,
  starter: 5,
  pro: 30,
  business: 100,
  enterprise: 300,
});

export const TRIAL_CHECKLIST_QUOTA = 10;

/** The monthly limit for the period covering now (`{ plan, kind }`), or 0 with none. */
export const checklistQuotaFor = (period) => {
  if (!period) return 0;
  if (period.kind === 'trial') return TRIAL_CHECKLIST_QUOTA;
  const plan = String(period.plan ?? '').toLowerCase();
  return Object.hasOwn(CHECKLIST_QUOTA, plan) ? CHECKLIST_QUOTA[plan] : 0;
};

export const roleHas = (role, permission) => (PERMISSIONS[role] ?? []).includes(permission);

export const planAllows = (plan, permission) => {
  const entitled = PLAN_GATED[permission];
  if (!entitled) return true;
  return entitled.includes(String(plan ?? '').toLowerCase());
};

export default {
  PERMISSIONS,
  ROLES,
  ASSIGNABLE_ROLES,
  PLAN_GATED,
  CHECKLIST_QUOTA,
  TRIAL_CHECKLIST_QUOTA,
  checklistQuotaFor,
  roleHas,
  planAllows,
  canActOn,
  canGrant,
  rolesActableBy,
};
