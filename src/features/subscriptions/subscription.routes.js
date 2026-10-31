import { Router } from 'express';
import SubscriptionController from './subscription.controller.js';
import { authenticate } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/authorize.js';

const router = Router();

router.use(authenticate);

// Every member reads which plan the organization is on and until when, a viewer
// included: it is why a feature is or is not available to them. Not plan-gated,
// or a lapsed organization could not see that it had lapsed.
router.get('/', authorize('tender:read'), SubscriptionController.current);

export default router;
