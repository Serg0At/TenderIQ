import { Router } from 'express';
import SupplierIdentityController from './supplierIdentity.controller.js';
import { authenticate } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import {
  supplierClaimSchema,
  supplierClaimParamsSchema,
  supplierSearchSchema,
} from '../../validations/schemas/trackedTender.schema.js';

const router = Router();

router.use(authenticate);

/**
 * Which parties in the public corpus this organisation bids AS — a set
 * (ticket 32), each claimed on its own.
 *
 * `org:manage`, not `bid:write`. Claiming an identity decides whose public win
 * record gets attributed to this account — it is an organisation-level
 * assertion, and a coordinator entering prices should not be able to
 * re-point it.
 */
router.get('/supplier-identity', authorize('tender:read'), SupplierIdentityController.list);
router.post('/supplier-identity', authorize('org:manage'), validate(supplierClaimSchema), SupplierIdentityController.claim);

// The picker behind the claim. Read-level, because it only surfaces public
// party names that are already searchable through the tender corpus.
router.get(
  '/supplier-identity/candidates',
  authorize('tender:read'),
  validate(supplierSearchSchema, 'query'),
  SupplierIdentityController.candidates
);

router.delete(
  '/supplier-identity/:partyId',
  authorize('org:manage'),
  validate(supplierClaimParamsSchema, 'params'),
  SupplierIdentityController.unclaim
);

export default router;
