import { Router } from 'express';
import IntegrationController from './integration.controller.js';
import TelegramWebhookController from './telegramWebhook.controller.js';
import { authenticate } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/authorize.js';
import { rateLimit } from '../../middlewares/rateLimit.js';

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
router.delete('/telegram/:id', authorize('savedsearch:write'), IntegrationController.unlinkTelegram);

/**
 * Switching a destination back on, for either channel.
 *
 * A subscription that is switched off keeps its row, its address and the
 * `verified_at` that proves someone owns it — revoking sets one timestamp and
 * erases nothing. So turning it back on clears that timestamp; it does not
 * repeat the deep link, and for Telegram that is the point, since the chat id
 * only exists because the user messaged the bot once.
 *
 * These are the only routes here scoped to the CALLER rather than the
 * organization. Turning a colleague's alerts off is configuration; turning them
 * on sends messages to their private chat or personal inbox, and the person who
 * turned it off may have been the recipient saying stop — through `/stop`, or
 * the unsubscribe link in a message. `savedsearch:write` must not overrule that.
 */
router.post('/telegram/:id/enable', authorize('savedsearch:write'), IntegrationController.enableTelegram);

/**
 * Email alerts, switched on and off exactly like a Telegram chat is linked and
 * unlinked — because under this model they are the same act: a live
 * `channel_subscriptions` row is what makes a channel deliver, and nothing else
 * does. This is where `PATCH /notifications/preferences` went.
 *
 * POST takes no body. The address is always the authenticated user's own
 * verified account address, which is what stops the endpoint from being a way
 * to aim an organization's alerts at a mailbox nobody consented to.
 */
router.get('/email', authorize('tender:read'), IntegrationController.listEmailAlerts);
router.post('/email', authorize('savedsearch:write'), IntegrationController.subscribeEmail);
router.delete('/email/:id', authorize('savedsearch:write'), IntegrationController.unsubscribeEmail);
router.post('/email/:id/enable', authorize('savedsearch:write'), IntegrationController.enableEmail);

export default router;
