import axios from 'axios';
import config from '../../../configs/variables.config.js';
import { logger } from '../../../utils/logger.js';

const { TELEGRAM } = config;

/**
 * The Telegram Bot API client — the only file that speaks to Telegram.
 *
 * Transport only. It knows nothing about notifications, organizations or quiet
 * hours; it takes a chat id and text and reports what happened. Recipient
 * resolution and delivery policy live in `services/notifier.service.js`, so the
 * rule that a third party sits behind one module holds without dragging
 * business logic in with it.
 *
 * Nothing here throws for an API-level failure. A dead provider must not abort
 * an alert fan-out to the other channels, so every call returns a classified
 * result and the caller decides.
 */

/** Telegram nests everything under /bot<token>/<method>. */
const endpoint = (method) => `${TELEGRAM.API_BASE}/bot${TELEGRAM.BOT_TOKEN}/${method}`;

export const isConfigured = () => Boolean(TELEGRAM.BOT_TOKEN);

/**
 * How a failure should be treated, which is the only thing the caller actually
 * needs to decide what to do next.
 *
 *   permanent — the chat is gone or the bot is blocked. Retrying can never
 *               succeed, so the subscription is revoked rather than retried
 *               forever. 403 is the common one: a user blocking the bot is a
 *               normal unsubscribe, not an incident.
 *   throttled — 429. Telegram supplies `retry_after`; honour it rather than
 *               burning an attempt, the same rule the scraper follows for
 *               RateLimitedError.
 *   transient — 5xx, timeouts, connection resets. Worth another attempt.
 *   invalid   — 400. The request was malformed, usually bad markup in the
 *               message. Retrying sends the same broken payload, so this is
 *               permanent for the message but must NOT revoke the chat.
 */
const classify = (status, body) => {
  if (status === 403 || status === 404) return 'permanent';
  if (status === 429) return 'throttled';
  if (status === 400) return 'invalid';
  if (status >= 500) return 'transient';
  // A 200 with ok:false is possible; Telegram uses the body, not just the code.
  if (body && body.ok === false) return 'invalid';
  return 'transient';
};

const call = async (method, payload, { timeoutMs } = {}) => {
  if (!isConfigured()) {
    return { ok: false, kind: 'unconfigured', detail: 'TELEGRAM_BOT_TOKEN is not set' };
  }

  try {
    const response = await axios.post(endpoint(method), payload, {
      timeout: timeoutMs ?? 15000,
      // Resolve every status so classification happens in one place rather than
      // being split between a try block and a catch block.
      validateStatus: () => true,
    });

    if (response.status === 200 && response.data?.ok) {
      return { ok: true, result: response.data.result };
    }

    const description = response.data?.description ?? `HTTP ${response.status}`;
    return {
      ok: false,
      kind: classify(response.status, response.data),
      detail: description,
      // Present on 429 and on migrated-chat errors.
      retryAfterSeconds: response.data?.parameters?.retry_after ?? null,
      migrateToChatId: response.data?.parameters?.migrate_to_chat_id ?? null,
    };
  } catch (error) {
    // Network-level: DNS, connection reset, or the client timeout above.
    return { ok: false, kind: 'transient', detail: error.message };
  }
};

/**
 * Send one message.
 *
 * `parse_mode: HTML` rather than MarkdownV2 on purpose. MarkdownV2 requires
 * escaping eighteen characters anywhere they appear — including `.`, `-` and
 * `!` — and a single missed one is a 400 that drops the alert. HTML needs three
 * (`&`, `<`, `>`), which is a rule small enough to get right every time. The
 * formatter owns that escaping.
 */
export const sendMessage = async ({ chatId, text, disablePreview = true }) =>
  call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: disablePreview,
  });

/**
 * Long-poll for updates.
 *
 * The HTTP timeout must exceed the long-poll hold or the client aborts a
 * request the server is deliberately holding open, which looks like a network
 * fault every single cycle. `allowed_updates` narrows the stream to messages —
 * the bot has no use for edits, reactions or channel posts, and asking for less
 * means less to parse and fewer surprises.
 */
export const getUpdates = async ({ offset, timeoutSeconds = TELEGRAM.POLL_TIMEOUT_SECONDS }) =>
  call(
    'getUpdates',
    { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'my_chat_member'] },
    { timeoutMs: (timeoutSeconds + 15) * 1000 }
  );

/**
 * Register the webhook.
 *
 * `secret_token` makes Telegram send `X-Telegram-Bot-Api-Secret-Token` on every
 * delivery, which is what lets an unauthenticated route reject forgeries.
 */
export const setWebhook = async ({ url, secret }) => {
  const result = await call('setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message', 'my_chat_member'],
    // Old updates queued while the webhook was down are almost always stale
    // link attempts whose tokens have since expired.
    drop_pending_updates: true,
  });
  if (result.ok) logger.info(`[telegram] webhook registered at ${url}`);
  else logger.error(`[telegram] setWebhook failed: ${result.detail}`);
  return result;
};

export const deleteWebhook = async () => call('deleteWebhook', { drop_pending_updates: false });

/** Used at startup to confirm the token is valid and to learn the bot's @name. */
export const getMe = async () => call('getMe', {});

export default {
  isConfigured,
  sendMessage,
  getUpdates,
  setWebhook,
  deleteWebhook,
  getMe,
};
