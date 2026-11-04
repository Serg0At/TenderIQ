import { Router } from 'express';
import OrganizationController from './organization.controller.js';
import { authenticate, authenticateOrgless } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { rateLimit } from '../../middlewares/rateLimit.js';
import {
  createOrganizationSchema,
  rosterQuerySchema,
  changeRoleSchema,
  transferOwnershipSchema,
  deleteOrganizationSchema,
  updateOrganizationSchema,
} from '../../validations/schemas/organization.schema.js';

const router = Router();

router.use(authenticateOrgless);

router.post('/', 
  rateLimit({ requests: 10, perMs: 3_600_000, bucket: 'org-create' }), 
  validate(createOrganizationSchema), 
  OrganizationController.create
);

/**
 * `/organization`, singular: the organization this session is acting in. No id
 * in the path, because the token already names exactly one — an id there could
 * only ever be redundant or a cross-tenant probe.
 */
export const currentOrganizationRoutes = Router();

currentOrganizationRoutes.use(authenticate);

// The organization's settings. Every member reads them; changing them is `org:manage`, the
// permission for organization settings — owner and admin.
currentOrganizationRoutes.get('/', authorize('tender:read'), OrganizationController.settings);
currentOrganizationRoutes.patch(
  '/',
  authorize('org:manage'),
  validate(updateOrganizationSchema),
  OrganizationController.updateSettings
);

// Every member reads the roster, a viewer included: `tender:read`, not `user:manage`.
currentOrganizationRoutes.get(
  '/members',
  authorize('tender:read'),
  validate(rosterQuerySchema, 'query'),
  OrganizationController.listMembers
);

// `user:manage` plus the rank rule in the service. Not plan-gated: shrinking or
// reassigning a team must never require paying again.
currentOrganizationRoutes.patch(
  '/members/:userId',
  authorize('user:manage'),
  validate(changeRoleSchema),
  OrganizationController.changeMemberRole
);

// Removal: `user:manage` plus the rank rule, not plan-gated.
currentOrganizationRoutes.delete(
  '/members/:userId',
  authorize('user:manage'),
  OrganizationController.removeMember
);

/**
 * Leaving: authenticated and nothing else. It is the caller's own membership,
 * so there is no permission to hold — and it is a separate endpoint from
 * removal precisely because the two have different gates.
 */
currentOrganizationRoutes.post('/leave', OrganizationController.leave);

/**
 * Deleting the organization. `org:manage` at the gate; owner-only, sole-member
 * and the typed-back name in the service. Admins hold `org:manage` too, which is
 * why the gate alone is not the rule. The name travels in the DELETE body — the
 * confirmation belongs to this one request, and a query string would put the
 * company's name into every access log on the way.
 */
currentOrganizationRoutes.delete(
  '/',
  authorize('org:manage'),
  validate(deleteOrganizationSchema),
  OrganizationController.deleteOrganization
);

/**
 * The only way ownership moves. `user:manage` at the gate, and owner-only in the
 * service against the database — admins hold `user:manage` too, and a previous
 * owner's token still says owner for a while after handing over.
 */
currentOrganizationRoutes.post(
  '/transfer-ownership',
  authorize('user:manage'),
  validate(transferOwnershipSchema),
  OrganizationController.transferOwnership
);

/**
 * The Field list a picker offers. On the orgless allowlist, because the first
 * screen that needs it is founding an organization — before there is a tenant
 * to read it from. Static data, but behind a token like everything else.
 */
export const fieldRoutes = Router();

fieldRoutes.get('/', authenticateOrgless, OrganizationController.fields);

export default router;
