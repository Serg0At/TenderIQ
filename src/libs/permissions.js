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
  // Operates across granted client orgs; same working permissions as a
  // coordinator plus the ability to switch client context.
  consultant: [
    'tender:read', 'intelligence:read',
    'savedsearch:write', 'trackedtender:write', 'bid:write',
    'vault:write', 'vault:read', 'report:export', 'client:switch',
  ],
};

export const ROLES = Object.keys(PERMISSIONS);

/**
 * Permissions that need an entitled plan on top of the role.
 *
 * A plan downgrade must remove intelligence for every role including owner,
 * so this is checked separately from the matrix rather than folded into it.
 */
export const PLAN_GATED = { 'intelligence:read': ['pro', 'business', 'enterprise'] };

export const roleHas = (role, permission) => (PERMISSIONS[role] ?? []).includes(permission);

export const planAllows = (plan, permission) => {
  const entitled = PLAN_GATED[permission];
  if (!entitled) return true;
  return entitled.includes(String(plan ?? '').toLowerCase());
};

export default { PERMISSIONS, ROLES, PLAN_GATED, roleHas, planAllows };
