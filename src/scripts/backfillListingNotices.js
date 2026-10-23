import { closeDb } from '../libs/knex.js';
import { getStorage } from '../libs/storage/index.js';
import { listingContext } from '../libs/adapters/source/gnumner/client.js';
import { parseListing } from '../libs/adapters/source/gnumner/listing.parser.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';
import listingNotices from '../repositories/listingNotice.repo.js';
import { noticeIndex } from '../workers/gnumner.js';
import { logger } from '../utils/logger.js';

/**
 * Fill `listing_notices` (ticket 31) from every gnumner listing page already
 * in storage — the notices swept before the listing chain recorded them.
 *
 *   node src/scripts/backfillListingNotices.js
 *
 * Reads storage only, never gnumner, and raises nothing: the index is what
 * "was an invitation of this code ever published" is asked of, not an event.
 * Each page is read through the same `noticeIndex` the chain uses, so the
 * rows are the ones a sweep would have written. Idempotent: an upsert per
 * notice.
 */
const SOURCE = 'gnumner';

const run = async () => {
  const storage = await getStorage();
  const totals = { pages: 0, notices: 0, failed: 0 };

  for (const page of await sourcePayloads.allByPrefix(SOURCE, 'listing:')) {
    const slug = page.ref.match(/^listing:(.+):p\d+$/)?.[1];
    try {
      const body = await storage.get(page.storage_key);
      const html = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
      const { items } = parseListing(html, listingContext());
      for (const item of items) {
        const index = noticeIndex(item, slug);
        if (!index) continue;
        await listingNotices.record({ source: SOURCE, ...index });
        totals.notices += 1;
      }
      totals.pages += 1;
    } catch (error) {
      totals.failed += 1;
      logger.error(`[listing-notices] ${page.ref} failed: ${error.message} (${page.storage_key})`);
    }
  }
  return totals;
};

run()
  .then((totals) => {
    logger.info(`[listing-notices] done: ${JSON.stringify(totals)}`);
    return closeDb().then(() => process.exit(totals.failed ? 1 : 0));
  })
  .catch(async (error) => {
    logger.error(`[listing-notices] aborted: ${error.message}`);
    await closeDb();
    process.exit(1);
  });
