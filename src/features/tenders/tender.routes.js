import { Router } from 'express';
import TenderController from './tender.controller.js';
import { authenticate } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { tenderQuerySchema } from '../../validations/schemas/tender.query.schema.js';

const router = Router();

// Every route passes gate 1 then gate 2. `tender:read` is held by all five
// roles, so this is about proving identity, not restricting access.
router.use(authenticate, authorize('tender:read'));

router.get('/', validate(tenderQuerySchema, 'query'), TenderController.list);

/**
 * The relevant list. Before `/:id`, or "relevant" would be read as a tender id.
 * The same `tender:read` every role holds, plus the `relevance` plan gate: the
 * ranking reads intelligence data (the public ledger, win history) and is sold
 * from `pro`. The two filters it leans on stay free on the plain list.
 */
router.get(
  '/relevant',
  authorize('tender:read', { planGate: 'relevance' }),
  validate(tenderQuerySchema, 'query'),
  TenderController.relevant
);
router.get('/:id', TenderController.detail);

export default router;
