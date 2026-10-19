import { closeDb } from '../libs/knex.js';
import { getStorage } from '../libs/storage/index.js';
import { getSourceConfig } from '../configs/sources.config.js';
import { parseDetail } from '../libs/adapters/source/eauction/detail.parser.js';
import parties from '../repositories/party.repo.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';

/**
 * Re-derive every party's name from the stored detail pages, after a change to
 * how names are cleaned. No request goes to the source.
 *
 * A normalizer replay cannot do this: `saveNormalized` rewrites the bid ledger —
 * and with it the supplier names — only when a tender's own fields changed, so
 * replaying an unchanged tender would fix its buyer and leave its bidders
 * exactly as they were. This touches parties and nothing else.
 *
 * Buyers are re-keyed FIRST. A buyer's identity is a hash of its name, so when
 * the identity rule changes, upserting before re-keying would mint a second row
 * beside the old one. Suppliers are keyed on their e-auction business operator id
 * and simply have their name corrected in place.
 *
 * Idempotent: a second run finds every name already correct and changes nothing.
 *
 * Usage:
 *   node src/scripts/repairPartyNames.js
 */

const SOURCE = 'eauction';

const run = async () => {
  const rekey = await parties.rekeyBuyers({ source: SOURCE });
  console.log(`buyers: ${rekey.checked} checked, ${rekey.rekeyed} re-keyed, ${rekey.collisions.length} left alone`);
  for (const c of rekey.collisions) console.log(`  collision: ${c.id} "${c.name}" — key already held by ${c.holder}`);

  const storage = await getStorage();
  const { baseUrl } = getSourceConfig(SOURCE);
  const payloads = (await sourcePayloads.latestByPrefix('detail:')).filter((p) => p.source === SOURCE);

  let pages = 0;
  let missing = 0;
  let unparsed = 0;
  for (const payload of payloads) {
    if (!(await storage.head(payload.storage_key))) {
      missing += 1;
      continue;
    }
    const body = await storage.get(payload.storage_key);
    let detail;
    try {
      detail = parseDetail(Buffer.isBuffer(body) ? body.toString('utf8') : String(body), { baseUrl });
    } catch {
      unparsed += 1;
      continue;
    }

    if (detail.buyerName) await parties.upsertBuyer({ source: SOURCE, name: detail.buyerName });
    for (const lot of detail.lots ?? []) {
      for (const bid of lot.bids ?? []) {
        await parties.upsertSupplier({ source: SOURCE, sourceId: bid.supplierSourceId, name: bid.supplierName });
      }
    }
    pages += 1;
    if (pages % 200 === 0) console.log(`  ${pages} / ${payloads.length} pages`);
  }

  console.log(`pages: ${pages} re-read, ${missing} missing from storage, ${unparsed} unparseable`);
};

run()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(`[repair-party-names] ${error.stack ?? error.message}`);
    await closeDb();
    process.exit(1);
  });
