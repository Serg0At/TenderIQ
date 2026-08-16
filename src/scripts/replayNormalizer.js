import db, { closeDb } from '../libs/knex.js';
import { getStorage } from '../libs/storage/index.js';
import { closeQueues, ingestNormalizeQueue } from '../queues/index.js';
import { JOB } from '../queues/names.js';

/**
 * `detail:`, not `notice:`. Listing rows are discovery markers whose stored
 * payload is the whole listing page; the normalizer reads tender detail pages.
 * Replaying `notice:` refs would feed listing HTML to a detail parser and
 * dead-letter every job.
 */
const DETAIL_PREFIX = 'detail:';
const replayRunId = Date.now();

/**
 * Requeue the latest raw snapshot for every notice. This is intentionally a
 * separate operator command: parser fixes should replay storage, never crawl
 * the public source again.
 */
const replay = async () => {
  const storage = await getStorage();
  const payloads = await db('source_payloads')
    .where('ref', 'like', `${DETAIL_PREFIX}%`)
    .orderBy([{ column: 'source', order: 'asc' }, { column: 'ref', order: 'asc' }, { column: 'fetched_at', order: 'desc' }]);

  const latestByNotice = new Map();
  for (const payload of payloads) {
    const key = `${payload.source}:${payload.ref}`;
    if (!latestByNotice.has(key)) latestByNotice.set(key, payload);
  }

  let queued = 0;
  let missing = 0;
  for (const payload of latestByNotice.values()) {
    if (!(await storage.head(payload.storage_key))) {
      missing += 1;
      continue;
    }
    const sourceId = payload.ref.slice(DETAIL_PREFIX.length);
    await ingestNormalizeQueue.add(
      JOB.NORMALIZE_TENDER,
      {
        source: payload.source,
        sourceId,
        ref: payload.ref,
        hash: payload.hash,
        storageKey: payload.storage_key,
      },
      { jobId: `replay-${replayRunId}-${payload.source}-${sourceId}-${payload.hash.slice(0, 12)}` }
    );
    queued += 1;
  }

  console.log(`Queued ${queued} latest notice payloads; skipped ${missing} missing raw objects.`);
};

try {
  await replay();
} finally {
  await closeQueues();
  await closeDb();
}
