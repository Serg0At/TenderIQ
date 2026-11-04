import { closeDb } from '../libs/knex.js';
import { getSourceConfig } from '../configs/sources.config.js';
import tenders from '../repositories/tender.repo.js';
import { ingestFetchQueue, closeQueues } from '../queues/index.js';
import { JOB, PRIORITY } from '../queues/names.js';
import { sha256 } from '../utils/hash.js';
import { logger } from '../utils/logger.js';

/**
 * Fetch the invitation archive for tenders that never got one.
 *
 * CPV codes and buyer tax IDs exist ONLY inside `hraver.docx`, so a tender
 * without its archive has both fields null — and neither the sweep nor the
 * seed will ever go back for it: documents are enqueued by the normalizer only
 * on a real change, and a settled tender never changes again.
 *
 * Run it after a seed, or any time `backfillDocuments` was off while tenders
 * were ingested. Idempotent: tenders that already have a document row are not
 * selected, and the handler makes no request for a tid whose archive is
 * already stored (ticket 35).
 *
 *   node src/scripts/backfillDocuments.js [--limit 500] [--source eauction]
 *
 * Cost is one request per tender against the shared 20/min budget, so ~500
 * tenders is about 25 minutes of polite fetching alongside whatever else runs.
 */
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const run = async () => {
  const source = String(arg('source', 'eauction'));
  const limit = Number(arg('limit', 500));

  if (!getSourceConfig(source).downloadDocuments) {
    logger.warn(`[documents] ${source} has downloadDocuments disabled — nothing to do`);
    return { queued: 0 };
  }

  const pending = await tenders.findMissingInvitationDocuments({ source, limit });
  if (!pending.length) {
    logger.info('[documents] every tender already has its invitation archive');
    return { queued: 0 };
  }

  let queued = 0;
  for (const tender of pending) {
    // The current link: an amended e-auction's creating id is a dead run (ticket 29).
    const sourceId = tender.external_id;
    await ingestFetchQueue.add(
      JOB.TENDER_DOCUMENTS,
      { source, sourceId, invitationUrl: tender.invitation_url },
      {
        // Same key the normalizer uses, so this cannot double up with a job it
        // already queued for the same archive.
        jobId: `${source}-docs-${sourceId}-${sha256(tender.invitation_url).slice(0, 12)}`,
        // Behind live traffic: filling in history must never delay a tender
        // published minutes ago.
        priority: PRIORITY.BACKFILL,
      }
    );
    queued += 1;
  }

  logger.info(
    `[documents] queued ${queued} invitation fetch(es)` +
      (pending.length === limit ? ` — limit reached, re-run for the rest` : '')
  );
  return { queued };
};

try {
  await run();
} catch (error) {
  logger.error(`[documents] failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await closeQueues();
  await closeDb();
}
