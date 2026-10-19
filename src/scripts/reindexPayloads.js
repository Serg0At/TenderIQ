import { closeDb } from '../libs/knex.js';
import { getStorage, PREFIX } from '../libs/storage/index.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';
import { closeQueues } from '../queues/index.js';
import { logger } from '../utils/logger.js';

/**
 * Rebuild `source_payloads` from object storage.
 *
 * `migrate:up` recreates the whole schema in one transaction, so any change to
 * an ingestion table means dropping `source_payloads` — the index of what has
 * already been fetched. Without this command the only way back is a full
 * re-crawl of the source, which grows from ~20 minutes today to ~25 hours once
 * the archive is backfilled, and makes every later schema change progressively
 * more expensive.
 *
 * It is safe because raw payloads are retained forever and their keys are
 * deterministic: `raw/{source}/{encodeURIComponent(ref)}/{hash}.{ext}` carries
 * the source, the ref and the content hash, which is exactly the (source, ref,
 * hash) triple the table is keyed on. Nothing has to be re-derived from the
 * network.
 *
 * Run order after a schema change:
 *   npm run migrate:down && npm run migrate:up
 *   npm run reindex          # rebuilds source_payloads from storage
 *   npm run normalize:replay # re-normalizes detail payloads into tenders
 *
 * Idempotent: `record()` treats a unique violation as success, so re-running
 * inserts nothing and reports every row as already present.
 *
 * What it does NOT restore: the `notice:{sourceId}` listing fingerprints. Those
 * rows point at a shared listing-page object rather than one of their own, so
 * there is no object to derive them from. The cost is bounded and small — the
 * sweep's tid watermark lives in Redis, which survives a database drop, so the
 * next sweep still stops at page 1 and merely re-verifies that page's notices.
 * Each of those detail fetches finds an unchanged content hash and writes
 * nothing. One cheap request per notice on one page, not a re-crawl.
 */

const RAW_PREFIX = `${PREFIX.RAW}/`;

/**
 * `raw/eauction/detail%3A46895/<hash>.html` -> { source, ref, hash }
 *
 * Returns null for anything that does not match rather than guessing, so an
 * unrelated object in the bucket is skipped and counted instead of being
 * written as a malformed payload row.
 */
export const parseRawKey = (key) => {
  if (!key.startsWith(RAW_PREFIX)) return null;
  const parts = key.slice(RAW_PREFIX.length).split('/');
  if (parts.length !== 3) return null;

  const [source, encodedRef, filename] = parts;
  const hash = filename.replace(/\.[^.]+$/, '');
  if (!source || !encodedRef || !/^[0-9a-f]{64}$/.test(hash)) return null;

  let ref;
  try {
    ref = decodeURIComponent(encodedRef);
  } catch {
    return null;
  }

  return { source, ref, hash };
};

const reindex = async () => {
  const storage = await getStorage();
  if (typeof storage.list !== 'function') {
    throw new Error('storage driver does not support list() — cannot reindex');
  }

  let seen = 0;
  let inserted = 0;
  let existing = 0;
  let skipped = 0;

  for await (const object of storage.list(RAW_PREFIX)) {
    seen += 1;
    const parsed = parseRawKey(object.key);
    if (!parsed) {
      skipped += 1;
      continue;
    }

    // fetched_at comes from the object's own timestamp, not now(): it is what
    // makes findLatestByRef order refs correctly after a rebuild. Getting this
    // wrong would make every payload look simultaneous and the normalizer's
    // stale-payload guard would pick an arbitrary winner.
    const recorded = await sourcePayloads.record({
      source: parsed.source,
      ref: parsed.ref,
      storageKey: object.key,
      hash: parsed.hash,
      fetchedAt: object.lastModified ?? new Date(),
    });

    if (recorded) inserted += 1;
    else existing += 1;

    if (seen % 500 === 0) logger.info(`[reindex] ${seen} objects scanned…`);
  }

  logger.info(
    `[reindex] done — ${seen} objects, ${inserted} inserted, ${existing} already present, ` +
      `${skipped} skipped (not a raw payload key)`
  );

  return { seen, inserted, existing, skipped };
};

export { reindex };

// Only run when invoked as a command, so parseRawKey stays importable by a
// test without the import itself hitting storage and the database.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    await reindex();
  } catch (error) {
    logger.error('[reindex] failed', error);
    process.exitCode = 1;
  } finally {
    await closeQueues();
    await closeDb();
  }
}
