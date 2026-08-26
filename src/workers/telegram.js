import config from '../configs/variables.config.js';
import redis from '../libs/redis.js';
import telegram from '../libs/adapters/channel/telegram.js';
import TelegramLinkService from '../services/telegramLink.service.js';
import { logger } from '../utils/logger.js';

const { TELEGRAM } = config;

/**
 * The inbound half of the Telegram channel: a long-polling `getUpdates` loop.
 *
 * Polling is the default because it needs no public URL. The webhook path is
 * better in production and exists, but it cannot be registered without HTTPS
 * that Telegram can reach, and this project has no deployed endpoint yet —
 * so the mode that works on a laptop is the one that ships enabled.
 *
 * This is NOT a BullMQ worker. `getUpdates` is a single long-lived cursor over
 * a stream Telegram will only hand to one consumer at a time, so it must run in
 * exactly one process. Modelling it as a queue job would let two workers fight
 * over the offset and silently drop half the updates — which is why
 * `TELEGRAM_MODE=off` exists for every replica but one.
 */

/**
 * The confirmed offset, in Redis rather than memory.
 *
 * Telegram redelivers everything above the last confirmed offset, so a restart
 * without a persisted cursor replays the backlog — re-running `/start` handlers
 * against tokens that have since been consumed. Redis is the right store: this
 * is pipeline position, exactly like `sweep:tid:{source}`.
 */
const OFFSET_KEY = 'telegram:offset';

let running = false;
let stopped = false;

const loadOffset = async () => {
  const raw = await redis.getRedis().get(OFFSET_KEY);
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const saveOffset = async (offset) => redis.getRedis().set(OFFSET_KEY, String(offset));

/**
 * One polling cycle.
 *
 * The offset is advanced only AFTER the batch is handled. Advancing first would
 * make a crash mid-batch lose those updates permanently, and a user whose
 * `/start` vanished has no way to know it needs retrying. Redelivery is
 * recoverable; loss is not — and the handlers tolerate it, since a consumed
 * token simply reports "already used".
 */
export const pollOnce = async () => {
  const offset = await loadOffset();
  const result = await telegram.getUpdates({ offset });

  if (!result.ok) {
    if (result.kind === 'unconfigured') return { polled: 0, stop: true };
    // Throttling and transient faults are normal on a long-lived loop; log and
    // let the caller back off rather than tearing the process down.
    return { polled: 0, error: result.detail, retryAfterSeconds: result.retryAfterSeconds };
  }

  const updates = result.result ?? [];
  if (!updates.length) return { polled: 0 };

  for (const update of updates) {
    try {
      await TelegramLinkService.handleUpdate(update);
    } catch (error) {
      // One malformed update must not stall the cursor forever. Log it and move
      // on — the alternative is a poison message that blocks every later link.
      logger.error(`[telegram] update ${update.update_id} failed: ${error.message}`);
    }
  }

  // +1: Telegram's offset is "the first update I have not confirmed".
  await saveOffset(Math.max(...updates.map((u) => u.update_id)) + 1);
  return { polled: updates.length };
};

/** Backoff for a failing poll, so an outage does not become a hot loop. */
const backoffMs = (consecutiveFailures, retryAfterSeconds) => {
  if (retryAfterSeconds) return retryAfterSeconds * 1000;
  return Math.min(30_000, 1000 * 2 ** Math.min(consecutiveFailures, 5));
};

export const startPolling = async () => {
  if (running) return;
  if (!telegram.isConfigured()) {
    logger.warn('[telegram] polling not started — TELEGRAM_BOT_TOKEN is not set');
    return;
  }

  // Confirms the token and proves which bot it is, so a wrong token surfaces at
  // startup instead of as silently absent alerts.
  const me = await telegram.getMe();
  if (!me.ok) {
    logger.error(`[telegram] getMe failed, polling not started: ${me.detail}`);
    return;
  }
  logger.info(`[telegram] polling as @${me.result?.username}`);

  // Telegram refuses getUpdates while a webhook is registered. Clearing it makes
  // switching TELEGRAM_MODE back to polling work without a manual API call.
  await telegram.deleteWebhook();

  running = true;
  stopped = false;
  let failures = 0;

  while (!stopped) {
    const result = await pollOnce();

    if (result.stop) break;

    if (result.error) {
      failures += 1;
      const wait = backoffMs(failures, result.retryAfterSeconds);
      logger.warn(`[telegram] poll failed (${result.error}), retrying in ${wait}ms`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    } else {
      failures = 0;
    }
  }

  running = false;
  logger.info('[telegram] polling stopped');
};

/**
 * Ask the loop to stop.
 *
 * Cooperative rather than an abort: the in-flight long poll is left to return
 * on its own so the current batch finishes and its offset is saved. Killing it
 * mid-batch would mean redelivery on the next boot, which is safe but noisy.
 */
export const stopPolling = () => {
  stopped = true;
};

export default { startPolling, stopPolling, pollOnce };
