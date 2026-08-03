/**
 * Producers (scheduler, API) and consumers (workers) live in different
 * processes, so a mistyped queue or job name does not crash anything — it
 * produces a job that is silently never picked up. Constants make that a
 * reference error instead.
 */
export const QUEUE = {
  INGEST_FETCH: 'ingest.fetch',
  INGEST_NORMALIZE: 'ingest.normalize',
};

export const JOB = {
  SOURCE_SWEEP: 'source.sweep',
  LISTING_PAGE: 'listing.page',
  NORMALIZE_TENDER: 'normalize.tender',
};

export default { QUEUE, JOB };
