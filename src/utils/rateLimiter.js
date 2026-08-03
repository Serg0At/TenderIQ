import redis from '../libs/redis.js';

/**
 * Fixed-window request budget, keyed per source.
 *
 * It lives in Redis rather than in process memory because politeness is a
 * property of the *source*, not of a worker: three scraper replicas must share
 * one budget instead of getting one each.
 *
 * Returns the number of ms to wait, or 0 when the request may proceed. Callers
 * must DELAY the job rather than fail it — being throttled is not an error and
 * must not consume one of the five retry attempts.
 */
export const acquire = async (source, { requests, perMs }) => {
  const client = redis.getRedis();
  const window = Math.floor(Date.now() / perMs);
  const key = `ratelimit:${source}:${window}`;

  const used = await client.incr(key);
  // Expire slightly past the window so a clock skew cannot leave a stuck key.
  if (used === 1) await client.pexpire(key, perMs + 1000);

  if (used <= requests) return 0;

  // Wait out the remainder of the current window.
  return perMs - (Date.now() % perMs);
};

/**
 * Run fn only if no other run holds the named lock.
 *
 * The armeps cron fires every 5 minutes and a post-outage deep sweep can take
 * longer than that at ~3.5s/page. Without this, sweeps stack up and the scraper
 * rate-limits itself into a spiral.
 */
export const withLock = async (name, ttlMs, fn) => {
  const client = redis.getRedis();
  const key = `lock:${name}`;
  const token = `${Date.now()}-${Math.random()}`;

  const acquired = await client.set(key, token, 'PX', ttlMs, 'NX');
  if (!acquired) return { skipped: true, result: null };

  try {
    return { skipped: false, result: await fn() };
  } finally {
    // Release only if the lock is still ours: a run that overran its TTL must
    // not delete the successor's lock.
    if ((await client.get(key)) === token) await client.del(key);
  }
};

export default { acquire, withLock };
