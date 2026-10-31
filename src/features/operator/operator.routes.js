import { Router } from 'express';
import OperatorController from './operator.controller.js';
import { authenticateOrgless } from '../../middlewares/auth.js';
import { authorizeOperator } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { createPromoCodeSchema, promoCodeQuerySchema } from '../../validations/schemas/operator.schema.js';

/**
 * The operator console: `/operator`.
 *
 * On the orgless allowlist, for the reason written beside it in auth.js: being
 * an operator belongs to the person, not to an organization. Every route sits
 * behind `authorizeOperator`, so an owner or admin of any organization is
 * refused exactly like a viewer.
 */
const router = Router();

router.use(authenticateOrgless, authorizeOperator);

router.post('/promo-codes', validate(createPromoCodeSchema), OperatorController.createPromoCode);
router.get('/promo-codes', validate(promoCodeQuerySchema, 'query'), OperatorController.listPromoCodes);
router.delete('/promo-codes/:id', OperatorController.removePromoCode);

export default router;
