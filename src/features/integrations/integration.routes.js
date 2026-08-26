import { Router } from 'express';
import IntegrationController from './integration.controller.js';
import TelegramWebhookController from './telegramWebhook.controller.js';
import { authenticate } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { rateLimit } from '../../middlewares/rateLimit.js';
import { quietHoursSchema } from '../../validations/schemas/integration.schema.js';

const router = Router();

/**
 * The webhook is mounted BEFORE `authenticate`, because Telegram cannot present
 * a token — its own secret header is the access control, checked in the
 * controller. Order matters: a router-level `authenticate` would reject every
 * update before the handler ever ran.
 *
 * Its own rate limit, tighter than the global one and keyed per IP: this is the
 * only unauthenticated write path in the API, so it is the one an attacker can
 * reach without an account.
 */
router.post(
  '/telegram/webhook',
  rateLimit({ requests: 120, perMs: 60_000 }),
  TelegramWebhookController.receive
);

router.use(authenticate);

/**
 * `savedsearch:write`, not `org:manage`.
 *
 * Linking a chat is configuring where alerts go, which is the same job as
 * defining what to be alerted about — so a coordinator who owns the saved
 * searches can also connect the chat that receives them. A `viewer` holds
 * neither and cannot.
 */
router.get('/telegram', authorize('tender:read'), IntegrationController.listTelegramLinks);
router.post('/telegram/link', authorize('savedsearch:write'), IntegrationController.createTelegramLink);
router.patch(
  '/telegram/:id/quiet-hours',
  authorize('savedsearch:write'),
  validate(quietHoursSchema),
  IntegrationController.setQuietHours
);
router.delete('/telegram/:id', authorize('savedsearch:write'), IntegrationController.unlinkTelegram);

export default router;
