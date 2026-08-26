import redis from '../libs/redis.js';
import { ApiError } from '../utils/errors.js';

/**
 * Per-caller request budget, in Redis rather than in process memory.
 *
 * Memory-local counters give every API replica its own allowance, so the real
 * limit silently becomes N times the configured one — the same reasoning that
 * put the scraper's politeness budget in Redis.
 *
 * Keyed on the authenticated user where there is one and the IP otherwise, so
 * one noisy tenant cannot exhaust the budget for everyone behind a shared
 * proxy.
 */
export const rateLimit = ({ requests = 120, perMs = 60_000, bucket = 'api' } = {}) =>
  async (req, res, next) => {
    try {
      const who = req.user?.id ?? req.ip;
      const window = Math.floor(Date.now() / perMs);
      const key = `ratelimit:${bucket}:${who}:${window}`;

      const client = redis.getRedis();
      const used = await client.incr(key);
      // Expire past the window so clock skew cannot strand a key at its cap.
      if (used === 1) await client.pexpire(key, perMs + 1000);

      const remaining = Math.max(requests - used, 0);
      res.set('X-RateLimit-Limit', String(requests));
      res.set('X-RateLimit-Remaining', String(remaining));

      if (used > requests) {
        const retryMs = perMs - (Date.now() % perMs);
        res.set('Retry-After', String(Math.ceil(retryMs / 1000)));
        return next(new ApiError('RATE_LIMITED', { details: { retryAfterSeconds: Math.ceil(retryMs / 1000) } }));
      }

      return next();
    } catch {
      // Redis being down must not take the API with it: rate limiting is a
      // protection, not a dependency, so a failure here fails open.
      return next();
    }
  };

export default { rateLimit };
