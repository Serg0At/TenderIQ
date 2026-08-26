import crypto from 'crypto';
import config from '../../configs/variables.config.js';
import TelegramLinkService from '../../services/telegramLink.service.js';
import { telegramUpdateSchema } from '../../validations/schemas/integration.schema.js';
import { logger } from '../../utils/logger.js';

const { TELEGRAM } = config;

/**
 * Constant-time comparison of the webhook secret.
 *
 * `===` on a secret leaks its length and prefix through timing. The cost here
 * is nil and the habit is the point: this is the only unauthenticated write
 * path in the API.
 */
const secretMatches = (presented) => {
  const expected = TELEGRAM.WEBHOOK_SECRET;
  if (!expected) return false;
  const a = Buffer.from(String(presented ?? ''));
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which is itself a length
  // oracle — so equalise first and let the comparison decide.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

export default class TelegramWebhookController {
  /**
   * Telegram's inbound update.
   *
   * Unauthenticated by necessity — Telegram cannot present a JWT — so the
   * secret header is the entire access control. Three deliberate choices:
   *
   * 1. **Refuse when no secret is configured.** A webhook that accepts anything
   *    because an env var is unset is worse than one that is switched off, and
   *    silently trusting unsigned input is how a bot gets used as a relay.
   * 2. **404, not 401**, on a bad secret. An unauthorised caller learns nothing
   *    about whether this endpoint exists or what it wants.
   * 3. **Always answer 200 once the secret checks out**, even when handling
   *    fails. Telegram retries non-2xx and escalates to disabling the webhook;
   *    a bug in our handler must not cost the integration. The failure is
   *    logged, and the user is told in-chat by the service.
   */
  static async receive(req, res) {
    if (!TELEGRAM.WEBHOOK_SECRET) {
      logger.warn('[telegram] webhook called but TELEGRAM_WEBHOOK_SECRET is not set — refusing');
      return res.status(404).end();
    }

    if (!secretMatches(req.get('x-telegram-bot-api-secret-token'))) {
      logger.warn('[telegram] webhook rejected: bad secret token');
      return res.status(404).end();
    }

    /**
     * Validated after the secret check, not before: an unauthenticated caller
     * should not be able to tell a malformed body from a rejected one, and
     * there is no reason to spend parsing on a request that is about to 404.
     *
     * Not the `validate` middleware, because that answers 422 on failure and
     * Telegram treats any non-2xx as a delivery to retry — see below.
     */
    const { value: update, error } = telegramUpdateSchema.validate(req.body ?? {}, {
      abortEarly: false,
      convert: true,
      stripUnknown: true,
    });

    if (error) {
      // Answered 200 so Telegram stops redelivering a body we will never
      // accept, and logged so a genuine schema drift is visible rather than
      // silently swallowed.
      logger.warn(`[telegram] webhook body failed validation: ${error.message}`);
      return res.status(200).json({ ok: true });
    }

    try {
      const result = await TelegramLinkService.handleUpdate(update);
      if (result.action !== 'ignored') {
        logger.info(`[telegram] webhook ${result.action}: ${result.result ?? 'ok'}`);
      }
    } catch (error) {
      logger.error(`[telegram] webhook handler failed: ${error.message}`);
    }

    return res.status(200).json({ ok: true });
  }
}
