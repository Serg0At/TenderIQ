import { Router } from 'express';
import SupplierIdentityController from './supplierIdentity.controller.js';
import { authenticate } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import {
  supplierIdentitySchema,
  supplierSearchSchema,
} from '../../validations/schemas/trackedTender.schema.js';

const router = Router();

router.use(authenticate);

/**
 * Which party in the public corpus this organisation bids AS.
 *
 * `org:manage`, not `bid:write`. Claiming an identity decides whose public win
 * record gets attributed to this account — it is an organisation-level
 * assertion, and a coordinator entering prices should not be able to
 * re-point it.
 */
router.get('/supplier-identity', authorize('tender:read'), SupplierIdentityController.get);
router.put('/supplier-identity', authorize('org:manage'), validate(supplierIdentitySchema), SupplierIdentityController.set);

// The picker behind the claim. Read-level, because it only surfaces public
// party names that are already searchable through the tender corpus.
router.get(
  '/supplier-identity/candidates',
  authorize('tender:read'),
  validate(supplierSearchSchema, 'query'),
  SupplierIdentityController.candidates
);

export default router;
