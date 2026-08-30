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
  /**
   * Health checks and housekeeping. Separate from ingest.fetch on purpose: the
   * moment you most need the alarm is when the fetch queue is backed up, and a
   * check sitting behind that backlog would stay silent exactly then.
   */
  MAINTENANCE: 'maintenance',
  /**
   * Matching and alert delivery. Separate from ingest.normalize so that fanning
   * one tender out across every saved search — unbounded work — can never slow
   * the write path that produced it.
   */
  ALERTS: 'alerts',
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
  /** Freshness, dead-letter depth and backlog — see workers/health.js. */
  HEALTH_CHECK: 'health.check',
  /** Refresh materialised price benchmarks — one tender's categories, or all. */
  RECOMPUTE_BENCHMARKS: 'benchmarks.recompute',
  /**
   * Rebuild buyer and supplier profiles. Separate from the benchmark job
   * because they fail independently and on different schedules: a benchmark
   * recompute is per-category and cheap, a profile rebuild walks every party.
   * Sharing a job name would make one of them invisible in the failed set.
   */
  RECOMPUTE_PROFILES: 'profiles.recompute',
  /** One ingested/amended tender vs every saved search. */
  MATCH_TENDER: 'match.tender',
  /** Hourly scan for approaching deadlines on already-matched tenders. */
  DEADLINE_REMINDER: 'deadline.reminder',
  /**
   * Send alerts whose quiet window has passed.
   *
   * The deferred `alert_deliveries` row is the queue, not a BullMQ delayed job:
   * a quiet window runs for hours, and a delayed job holding the payload that
   * long would be lost to a Redis flush while the alert itself is already
   * durable in Postgres. This sweep re-reads and sends.
   */
  DELIVER_DEFERRED: 'notify.deferred',
  /**
   * Resolve submitted customer bids against the public bid ledger.
   *
   * Database-driven and scheduled rather than event-driven, for the same
   * reason TENDER_REFRESH is: a tender settles weeks after the bid was
   * submitted, and the worker that normalizes the settlement knows nothing
   * about which tenants were bidding on it. Making normalization aware of
   * tenants would put private data in the ingestion path.
   *
   * Rides the ALERTS queue: its output is a customer-visible result, it is
   * cheap, and it must not sit behind an ingest backlog on the day a customer
   * is waiting to hear whether they won.
   */
  RECONCILE_BIDS: 'bids.reconcile',
  /**
   * Read one tender invitation into a bid checklist.
   *
   * User-triggered, never scheduled: it costs a model call per run, so it must
   * be an explicit action that lands in a queue with retry semantics rather
   * than something a page load can repeat. Rides ALERTS for the same reason
   * bid reconciliation does — the output is customer-facing, and it must not
   * queue behind an ingest backlog.
   */
  EXTRACT_CHECKLIST: 'checklist.extract',
  /**
   * Daily sweep of the document vault: expiry warnings, lapsed-document alerts
   * and pruning of uploads that were registered but never completed.
   *
   * Rides ALERTS rather than MAINTENANCE for the same reason the reminders do —
   * what it produces is a customer-facing warning with a deadline attached, not
   * housekeeping, and it must not queue behind a nightly profile rebuild on the
   * day a certificate lapses.
   */
  VAULT_EXPIRY: 'vault.expiry',
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
