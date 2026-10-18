import { closeDb } from '../libs/knex.js';
import tenders from '../repositories/tender.repo.js';
import TenderDocumentService from '../services/tenderDocument.service.js';
import { logger } from '../utils/logger.js';

/**
 * List the files inside every stored invitation archive that has no manifest.
 *
 * Archives stored before `tender_documents.manifest` existed show as
 * `unlisted` on the tender page until this runs. It makes no source request:
 * each archive is read from object storage, and only its tail and central
 * directory — tens of kilobytes, however large the archive.
 *
 *   node src/scripts/backfillDocumentManifests.js [--batch 100]
 *
 * Idempotent: only NULL manifests are selected, and the write fills a blank
 * only. A row that fails is logged and passed over (keyset by id), so one
 * unreadable archive cannot stall the run; re-running retries it.
 */
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const run = async () => {
  const batch = Number(arg('batch', 100));
  const totals = { listed: 0, files: 0, skipped: 0, failed: 0 };

  for (let afterId = null; ; ) {
    const rows = await tenders.findDocumentsWithoutManifest({ afterId, limit: batch });
    if (!rows.length) break;

    for (const row of rows) {
      try {
        const result = await TenderDocumentService.backfillManifest(row);
        if (result.skipped) {
          totals.skipped += 1;
          logger.warn(`[manifests] ${row.id} skipped: ${result.skipped} (${row.storage_key})`);
        } else {
          totals.listed += 1;
          totals.files += result.listed;
        }
      } catch (error) {
        totals.failed += 1;
        logger.error(`[manifests] ${row.id} failed: ${error.message} (${row.storage_key})`);
      }
    }
    afterId = rows[rows.length - 1].id;
    logger.info(`[manifests] ${JSON.stringify(totals)}`);
  }

  return totals;
};

run()
  .then((totals) => {
    logger.info(`[manifests] done: ${JSON.stringify(totals)}`);
    return closeDb().then(() => process.exit(totals.failed ? 1 : 0));
  })
  .catch(async (error) => {
    logger.error(`[manifests] aborted: ${error.message}`);
    await closeDb();
    process.exit(1);
  });
