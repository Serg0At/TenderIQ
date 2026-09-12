import { Router } from 'express';
import UnsubscribeController from './unsubscribe.controller.js';
import { rateLimit } from '../../middlewares/rateLimit.js';

const router = Router();

/**
 * Unauthenticated on purpose: the whole point is that it works from a mail
 * client, where nobody is signed in. The token IS the authorization, and it can
 * do exactly one thing — stop alerts on the single subscription it names.
 * Nothing here reads tenant data, and there is no token that turns a channel
 * back on.
 *
 * Rate limited per IP and tighter than the global ceiling, like the Telegram
 * webhook. These are the only two unauthenticated paths in the API, so they are
 * the ones reachable without an account. The limit is not what stops forged
 * tokens — an HMAC does that — it stops someone burning the server's time
 * checking millions of them.
 */
router.use(rateLimit({ requests: 30, perMs: 60_000, bucket: 'unsubscribe' }));

// GET previews and POST acts. See the controller: mail scanners open every link
// in a message, so the side effect cannot live on the verb they use.
router.get('/', UnsubscribeController.preview);
router.post('/', UnsubscribeController.confirm);

export default router;
