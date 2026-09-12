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
};

export const roleHas = (role, permission) => (PERMISSIONS[role] ?? []).includes(permission);

export const planAllows = (plan, permission) => {
  const entitled = PLAN_GATED[permission];
  if (!entitled) return true;
  return entitled.includes(String(plan ?? '').toLowerCase());
};

export default { PERMISSIONS, ROLES, PLAN_GATED, roleHas, planAllows };
