import { Router } from 'express';
import SubscriptionController from './subscription.controller.js';
import { authenticate } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/authorize.js';
import { rateLimit } from '../../middlewares/rateLimit.js';

const router = Router();

router.use(authenticate);

// Every member reads which plan the organization is on and until when, a viewer
// included: it is why a feature is or is not available to them. Not plan-gated,
// or a lapsed organization could not see that it had lapsed.
router.get('/', authorize('tender:read'), SubscriptionController.current);

// The owner's only (`billing:manage`, re-checked against `memberships` in the
// service). Not plan-gated: it is how an organization on `free` leaves it.
// It can succeed once, so the limit only bounds a client retrying a refusal.
router.post(
  '/trial',
  authorize('billing:manage'),
  rateLimit({ requests: 10, perMs: 3_600_000, bucket: 'trial-start' }),
  SubscriptionController.startTrial
);

export default router;
