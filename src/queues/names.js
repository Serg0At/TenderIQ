import { sha256 } from '../utils/hash.js';

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
   * Database-driven re-check of a source's unsettled tenders, one schedule per
   * source (`refresh-{source}`). For e-auction it is the tenders whose auction
   * has passed: the listing sweep stops at its tid watermark and so only ever
   * sees newly published tenders, and this is what catches a month-old tender
   * turning into an award. For armeps.am it is every open tender, because
   * there a deadline moves without the gnumner notice changing.
   */
  TENDER_REFRESH: 'tender.refresh',
  /**
   * Invitation archive -> CPV, buyer tax ID, per-lot item text. Rides
   * ingest.fetch for the same reason tender.detail does: same host, same rate
   * budget.
   */
  TENDER_DOCUMENTS: 'tender.documents',
  /**
   * One armeps.am tender page, keyed by `resourceId`: discovered on gnumner,
   * or re-checked by the ARMEPS refresh. Rides ingest.fetch like every other
   * detail fetch.
   */
  ARMEPS_DETAIL: 'armeps.detail',
  /**
   * One armeps.am tender's contract documents, as the single ZIP the page
   * offers: the files, and the Tender Structure XML its lots come from. Its
   * own job rather than TENDER_DOCUMENTS because nothing about it is shared
   * but the queue — another client, another archive layout.
   */
  ARMEPS_DOCUMENTS: 'armeps.documents',
  /**
   * One uploaded paper invitation on gnumner, with the listing's publish
   * datetime its deadline is counted from (workers/paper.js). Also the paper
   * refresh's job (`reason: 'refresh'`), which makes no request and only
   * re-normalizes the stored file so a tender past its deadline closes.
   */
  PAPER_INVITATION: 'paper.invitation',
  /**
   * A paper tender's invitation, stored and listed as its document, and its
   * lots written. Reads the file the invitation fetch stored — no request —
   * so it shares nothing with the other document jobs but the queue.
   */
  PAPER_DOCUMENTS: 'paper.documents',
  /**
   * One upload on gnumner's amendment listing: a buyer's notice that it
   * changed a paper invitation (ticket 07). Stored, matched to its tender on
   * code and dates, and recorded as an addendum document (workers/paper.js).
   */
  PAPER_AMENDMENT: 'paper.amendment',
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
  /**
   * Deliver one already-recorded notification to every destination its
   * organization has.
   *
   * For alerts raised by the API rather than a worker sweep — team
   * announcements today. The request records the notification and returns;
   * the Telegram and SMTP round trips happen here, where a slow provider cannot
   * hold an HTTP response open and a throttle has retry semantics. Rides ALERTS
   * like every other customer-facing message.
   */
  DELIVER_NOTIFICATION: 'notify.deliver',
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

/**
 * The match job of one tender version. Every producer of an amendment builds
 * its id here — the normalizer for a moved field, the document stage for an
 * addendum — because both advance one version counter, and two spellings of
 * this id would match the same amendment twice.
 */
export const matchJobId = (tenderId, version) => `match-${tenderId}-v${version}`;

/**
 * The match that runs again when a tender's archive is stored (ticket 25): an
 * e-auction's CPV codes, and both sources' lot names, arrive with it, after the
 * ingest match has run. One per stored archive, keyed on its storage key —
 * which names the archive's identity — so a retry reuses the id and a re-issue
 * gets its own. Hashed because the key holds slashes.
 */
export const documentsMatchJobId = (tenderId, storageKey) =>
  `match-${tenderId}-docs-${sha256(storageKey).slice(0, 12)}`;

export default { QUEUE, JOB, PRIORITY, matchJobId, documentsMatchJobId };
