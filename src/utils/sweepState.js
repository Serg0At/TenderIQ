import redis from '../libs/redis.js';

/**
 * Sweep state shared by every source's listing sweep: the freshness signal and
 * the high-water mark that bounds pagination depth.
 */

/**
 * Written on every successful listing page and read by the health check.
 *
 * Not `max(source_payloads.fetched_at)`: unchanged content is never inserted,
 * so that would report the last *change* rather than the last *fetch*, and a
 * quiet-but-healthy source would look dead.
 */
export const markSweepHealthy = (source) =>
  redis.getRedis().set(`sweep:ok:${source}`, Date.now(), 'EX', 7 * 24 * 60 * 60);

export const lastSuccessfulSweep = async (source) => {
  const value = await redis.getRedis().get(`sweep:ok:${source}`);
  return value ? new Date(Number(value)) : null;
};

/** A numeric high-water mark; 0 when the key has never been written. */
export const readHighWater = async (key) => {
  const value = await redis.getRedis().get(key);
  return value ? Number(value) : 0;
};

/**
 * Advanced only when a sweep chain terminates, and only forwards. A sweep that
 * dies mid-chain leaves the old value, so the next run re-walks the gap rather
 * than skipping over notices it never actually ingested.
 *
 * Compare-and-set in one round trip. The sweep lock is released as soon as
 * page 1 is enqueued, so two chains can be in flight at once; a read-then-
 * write would let a slower chain's lower value overwrite a higher one and
 * regress the watermark, causing pages to be re-walked indefinitely.
 */
export const advanceHighWater = async (key, value) => {
  if (!Number.isFinite(value) || value <= 0) return;
  await redis
    .getRedis()
    .eval(
      'local c = redis.call("GET", KEYS[1]) if (not c) or (tonumber(ARGV[1]) > tonumber(c)) then redis.call("SET", KEYS[1], ARGV[1]) end return 1',
      1,
      key,
      String(value)
    );
};

export default { markSweepHealthy, lastSuccessfulSweep, readHighWater, advanceHighWater };
