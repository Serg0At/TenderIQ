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
 * Compare-and-set in one round trip. The chain marker (`chainKey`) keeps one
 * chain per listing, but a chain whose marker lapsed still runs beside its
 * successor, so two chains can be in flight at once; a read-then-
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

/**
 * The floor of a watermark: the oldest mark from which every notice up to the
 * watermark has been read, with no gap. Together they are the window a
 * listing's sweeps fully cover (ticket 31) — what lets "no notice of this
 * code" mean "none was published" rather than "none was read".
 *
 * A cold start sets it to the oldest mark it read (`maxListingPages` deep). A
 * chain that reaches the watermark leaves it, since it read everything in
 * between. A chain stopped by the page ceiling before the watermark leaves a
 * hole under what it read, so the floor rises to its oldest mark: coverage is
 * kept as one unbroken stretch, and what lies below a hole is forgotten
 * rather than vouched for. Written before the watermark advances, so a crash
 * in between can only leave the window narrower than it is.
 */
export const floorKey = (watermarkKey) => `${watermarkKey}:floor`;

export const setFloor = async (key, value) => {
  if (!Number.isFinite(value) || value <= 0) return;
  await redis.getRedis().set(key, String(value));
};

/** Only upwards, compare-and-set like `advanceHighWater`. */
export const raiseFloor = async (key, value) => {
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

/**
 * The in-flight marker of a watermark's chain (ticket 38): the id of the one
 * chain walking that listing, so a sweep that finds it starts none. Without
 * it a five-minute cron stacked a new chain on every slow one — 48 e-auction
 * listing pages queued at once — and each re-read the same pages exactly when
 * the rate budget was needed for detail pages.
 *
 * Set by the sweep when it queues page 1, re-set by every page, deleted by the
 * page that ends the chain. Only the holder may refresh or delete it, so a
 * chain whose marker lapsed and was taken by a newer one cannot release the
 * newer one's. The TTL is what keeps a chain that vanished without ending
 * (a job lost, a stall past BullMQ's limit) from closing the listing forever.
 */
export const chainKey = (watermarkKey) => `${watermarkKey}:chain`;

/** `SET NX`: true when no chain holds the listing and `chain` now does. */
export const claimChain = async (key, chain, ttlMs) =>
  (await redis.getRedis().set(key, chain, 'PX', ttlMs, 'NX')) === 'OK';

/**
 * Re-arm the TTL while the marker is ours, or take it back if it lapsed and
 * nobody else has: a chain that outlived its TTL is still the one walking.
 * False when another chain holds it.
 */
export const holdChain = async (key, chain, ttlMs) =>
  (await redis
    .getRedis()
    .eval(
      'local c = redis.call("GET", KEYS[1]) if (not c) or c == ARGV[1] then redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2]) return 1 end return 0',
      1,
      key,
      chain,
      String(ttlMs)
    )) === 1;

/** Delete the marker only if `chain` holds it. */
export const releaseChain = (key, chain) =>
  redis
    .getRedis()
    .eval(
      'if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("DEL", KEYS[1]) end return 1',
      1,
      key,
      chain
    );

/**
 * `{ from, to }`, the floor and the watermark of one listing, or null when
 * either is missing — a listing swept before floors were kept covers nothing
 * Tendra can vouch for.
 */
export const readCoverage = async (watermarkKey) => {
  const [high, floor] = await redis.getRedis().mget(watermarkKey, floorKey(watermarkKey));
  if (!high || !floor) return null;
  return { from: Number(floor), to: Number(high) };
};

/**
 * Claim one item of a refresh for `ttlSeconds`: true when nobody asked about
 * it within that time, and it is now marked asked. For a refresh with no
 * stored page whose age says how stale an item is — PPCM's, which asks after
 * tenders it may not hold a single row for. `SET NX`, so two overlapping runs
 * never both claim one item. A flushed Redis only means an item is asked
 * about again sooner.
 */
export const claimPoll = async (key, ttlSeconds) =>
  (await redis.getRedis().set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK';

export default {
  claimPoll,
  markSweepHealthy,
  lastSuccessfulSweep,
  readHighWater,
  advanceHighWater,
  floorKey,
  setFloor,
  raiseFloor,
  chainKey,
  claimChain,
  holdChain,
  releaseChain,
  readCoverage,
};
