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
} from '../../validations/schemas/organization.schema.js';

const router = Router();

// On the orgless allowlist: founding an organization is how a user stops being orgless.
router.use(authenticateOrgless);

/**
 * The collection of organizations, as opposed to `/organization` — the one the
 * session is acting in.
 *
 * Creating one takes no `authorize`: there is no tenant yet to hold a role in.
 * The per-account cap in the service is the real limit; this budget, keyed on
 * the user because it runs after `authenticate`, stops a script hammering the
 * transaction that enforces it.
 */
const createLimit = rateLimit({ requests: 10, perMs: 3_600_000, bucket: 'org-create' });

router.post('/', createLimit, validate(createOrganizationSchema), OrganizationController.create);

/**
 * `/organization`, singular: the organization this session is acting in. No id
 * in the path, because the token already names exactly one — an id there could
 * only ever be redundant or a cross-tenant probe.
 */
export const currentOrganizationRoutes = Router();

currentOrganizationRoutes.use(authenticate);

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

export default router;
