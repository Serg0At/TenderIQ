import { closeDb } from '../libs/knex.js';
import { getStorage } from '../libs/storage/index.js';
import { bufferSource, listEntries } from '../libs/adapters/archive/zip.js';
import { parseInvitation } from '../libs/adapters/source/gnumner/invitation.parser.js';
import { agreedTaxId } from '../libs/taxId.js';
import parties from '../repositories/party.repo.js';
import { readBuyerTaxId } from '../workers/armeps.js';
import { logger } from '../utils/logger.js';

/**
 * Give ARMEPS and paper buyers the ՀՎՀՀ their stored documents state, then
 * merge every buyer that shares one with another source's buyer (ticket 19).
 * Read from storage only, never from a source.
 *
 *   node src/scripts/mergeBuyers.js                               # dry run: the counts, then rolled back
 *   node src/scripts/mergeBuyers.js --apply                       # write them
 *   node src/scripts/mergeBuyers.js --apply --confirm 02625503    # and merge a refused group a person read
 *
 * The dry run does everything in one transaction and rolls it back, so its
 * counts are the merges `--apply` makes, not an estimate. Every merge is the
 * production one (`parties.mergeBuyers`): by ՀՎՀՀ, buyer with buyer, and a
 * group whose names differ by more than quoting and case is refused and
 * listed — a branch holds its parent's ՀՎՀՀ. `--confirm` (repeatable) is a
 * person's decision that one refused group is one buyer. It raises no alert: a tender moved to its merged buyer
 * is not amended, and the next read of its source resolves there through the
 * alias, so it is not amended later either.
 *
 * Idempotent: only buyers with no ՀՎՀՀ are read, a ՀՎՀՀ only fills a blank,
 * and a merged group is one party. Re-run it after adding a .doc or .pdf
 * reader, or after the archive backfill.
 */
const apply = process.argv.includes('--apply');
const confirmed = new Set(process.argv.flatMap((arg, i, args) => (args[i - 1] === '--confirm' ? [arg] : [])));

/** What each source's stored document set says the buyer's ՀՎՀՀ is. */
const READERS = {
  armeps: async (bytes, storageKey) => {
    const archive = bufferSource(bytes);
    // `tender-docs/armeps/{resourceId}/{hash}.zip`, as tenderDocument.service.js reads it.
    return readBuyerTaxId(archive, await listEntries(archive), storageKey.split('/')[2]);
  },
  gnumner: async (bytes) => (await parseInvitation(bytes)).document?.taxId ?? null,
};

/** One buyer's sets, each read; the ՀՎՀՀ they agree on. */
const readBuyers = async (source, storage, totals) => {
  const rows = await parties.buyersAwaitingTaxId(source);
  const byParty = new Map();
  for (const row of rows) {
    const party = byParty.get(row.id) ?? { ...row, keys: [] };
    party.keys.push(row.storage_key);
    byParty.set(row.id, party);
  }

  const found = [];
  for (const party of byParty.values()) {
    totals.buyersRead += 1;
    const values = [];
    for (const key of party.keys) {
      totals.setsRead += 1;
      try {
        const body = await storage.get(key);
        const value = await READERS[source](Buffer.isBuffer(body) ? body : Buffer.from(body), key);
        if (value) {
          totals.setsWithTaxId += 1;
          values.push(value);
        }
      } catch (error) {
        totals.failed += 1;
        logger.error(`[buyers-merge] ${party.source_id} ${key}: ${error.message}`);
      }
    }
    const taxId = agreedTaxId(values);
    if (taxId) found.push({ ...party, taxId });
    else if (values.length) {
      totals.disagree += 1;
      logger.warn(`[buyers-merge] ${party.source_id} «${party.name}»: its sets disagree — ${[...new Set(values)].join(', ')}`);
    } else totals.noTaxId += 1;
  }
  return found;
};

const run = async () => {
  const storage = await getStorage();
  const totals = {
    buyersRead: 0,
    setsRead: 0,
    setsWithTaxId: 0,
    gainedTaxId: 0,
    noTaxId: 0,
    disagree: 0,
    failed: 0,
    pairsMerged: 0,
    groupsRefused: 0,
  };

  const found = [];
  for (const source of Object.keys(READERS)) found.push(...(await readBuyers(source, storage, totals)));

  const { gained, merges } = await parties.fillAndMergeBuyers(found, { commit: apply, confirmed });
  totals.gainedTaxId = gained;
  for (const { taxId, merged, refused } of merges) {
    for (const loser of merged) {
      totals.pairsMerged += 1;
      logger.info(
        `[buyers-merge] ${taxId}: ${loser.source_id} «${loser.name}» (${loser.tenders} tenders) → ` +
          `${loser.into.source_id} «${loser.into.name}»`
      );
    }
    if (refused) {
      totals.groupsRefused += 1;
      logger.warn(
        `[buyers-merge] ${taxId}: not merged, the names differ — read them, then --confirm ${taxId} if one buyer: ` +
          refused.map((b) => `${b.source_id} «${b.name}»`).join(', ')
      );
    }
  }
  return totals;
};

run()
  .then((totals) => {
    logger.info(`[buyers-merge] ${apply ? 'applied' : 'dry run, rolled back'}: ${JSON.stringify(totals)}`);
    return closeDb().then(() => process.exit(totals.failed ? 1 : 0));
  })
  .catch(async (error) => {
    logger.error(`[buyers-merge] aborted: ${error.message}`);
    await closeDb();
    process.exit(1);
  });
