import { roleHas, planAllows } from '../libs/permissions.js';
import { ApiError } from '../utils/errors.js';

/**
 * Gates 2 and 4: does the role carry this permission, and does the plan entitle
 * it?
 *
 * An orgless session (no membership: just registered, or just removed) holds
 * null claims and is refused here with NO_ORGANIZATION before the role is even
 * read. Every permission lives inside a tenant, so there is no permission such a
 * session can hold. The orgless allowlist is `authenticateOrgless` in auth.js.
 * The screen is never the enforcement; these null claims are.
 *
 * Default-deny — an unknown role or a missing permission is a refusal, never a
 * pass. Ordering matters for the error the client sees: role is checked before
 * plan, so a `viewer` on an Enterprise plan is told their ROLE is the problem
 * rather than being invited to upgrade a plan that would not help.
 */
export const authorize = (permission, { planGate = permission } = {}) => (req, _res, next) => {
  if (!req.user) return next(ApiError.unauthenticated());

  // `authenticate` already refuses an orgless session; this is the second line
  // for a route mounted on `authenticateOrgless` that also asks for a permission.
  if (!req.user.organizationId) {
    return next(ApiError.forbidden('NO_ORGANIZATION', { permission }));
  }

  if (!roleHas(req.user.role, permission)) {
    return next(ApiError.forbidden('ROLE_FORBIDDEN', { permission, role: req.user.role }));
  }

  // `planGate` defaults to the permission itself; a route names a feature key
  // instead when the permission is shared with routes that must stay ungated.
  if (!planAllows(req.user.plan, planGate)) {
    // 402, not 403: this one is fixable by the customer, and the distinction is
    // what lets the client show an upgrade prompt instead of a dead end.
    return next(
      new ApiError('PLAN_UPGRADE_REQUIRED', { details: { permission, feature: planGate, plan: req.user.plan } })
    );
  }

  return next();
};

/**
 * Gate 3: does this resource belong to the caller's organization?
 *
 * Tenant isolation is enforced in repositories by scoping queries on
 * organization_id — this is the second line for the case where a handler has
 * already loaded a row by its primary key. It answers NOT_FOUND rather than
 * TENANT_FORBIDDEN when asked to hide existence, since "forbidden" confirms the
 * id is real and lets an attacker enumerate.
 */
export const assertSameTenant = (req, resource, { hideExistence = true } = {}) => {
  if (!resource) throw ApiError.notFound();
  if (resource.organization_id !== req.user?.organizationId) {
    throw hideExistence ? ApiError.notFound() : ApiError.forbidden('TENANT_FORBIDDEN');
  }
  return resource;
};

export default { authorize, assertSameTenant };
