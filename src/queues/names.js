/**
 * Producers (scheduler, API) and consumers (workers) live in different
 * processes, so a mistyped queue or job name does not crash anything — it
 * produces a job that is silently never picked up. Constants make that a
 * reference error instead.
 */
export const QUEUE = {
  INGEST_FETCH: 'ingest.fetch',
  INGEST_NORMALIZE: 'ingest.normalize',
  /**
   * One-time historical seed, on its own queue and its own process so a
   * multi-day archive walk can be started and stopped without touching the
   * live pipeline. Politeness is still shared: the rate limiter is keyed per
   * source in Redis, so both processes draw on one budget.
   */
  INGEST_BACKFILL: 'ingest.backfill',
};

export const JOB = {
  SOURCE_SWEEP: 'source.sweep',
  LISTING_PAGE: 'listing.page',
  /**
   * Rides the ingest.fetch queue rather than one of its own: a detail fetch has
   * the identical politeness profile to a listing page (same host, same rate
   * budget, same delay-don't-fail throttle handling), and a second fetch queue
   * would quietly double the concurrency pointed at the source.
   */
  TENDER_DETAIL: 'tender.detail',
  /**
   * Database-driven re-check of tenders whose auction has passed. The listing
   * sweep stops at its tid watermark and so only ever sees newly published
   * tenders; this is what catches a month-old tender turning into an award.
   */
  TENDER_REFRESH: 'tender.refresh',
  /**
   * Invitation archive -> CPV, buyer tax ID, per-lot item text. Rides
   * ingest.fetch for the same reason tender.detail does: same host, same rate
   * budget.
   */
  TENDER_DOCUMENTS: 'tender.documents',
  /** One page of the historical seed. Chains to the next page. */
  BACKFILL_PAGE: 'backfill.page',
  NORMALIZE_TENDER: 'normalize.tender',
};

/**
 * BullMQ processes lower numbers first. The seed enqueues ~29,000 jobs onto the
 * same queues the live pipeline uses, so without this a newly published tender
 * would queue behind hours of history and blow the 15-minute freshness target.
 *
 * EVERY producer must set one of these explicitly. An `add()` with no priority
 * lands in the plain wait list, which BullMQ drains ahead of the prioritized
 * set — effectively priority 0, higher than LIVE. Mixing the two starved the
 * document stage completely: 19 `tender.documents` jobs sat unprocessed behind
 * a sweep that re-filled the wait list every five minutes.
 */
export const PRIORITY = {
  LIVE: 1,
  BACKFILL: 10,
};

export default { QUEUE, JOB, PRIORITY };
