import { closeDb } from '../libs/knex.js';
import CpvClassifierService from '../services/cpvClassifier.service.js';
import { logger } from '../utils/logger.js';

/**
 * Load the Ministry of Finance's CPV classifier from gnumner into
 * `cpv_classifier` (cpv-inference ticket 01, ADR 0006).
 *
 *   npm run cpv:refresh              # dry run: what the current file would change
 *   npm run cpv:refresh -- --apply   # write it, in one transaction
 *
 * Downloads the full list and the e-auction subset — found by their links on
 * the site, never by file name — and reports the codes added, withdrawn,
 * restored, renamed or given another unit against the stored version, and the
 * stated codes in the database the file does not name. `--apply` touches no
 * tender or lot.
 */
const apply = process.argv.includes('--apply');
const SHOW = 25;

const line = (message) => logger.info(`[cpv-refresh] ${message}`);

const list = (title, items, show) => {
  if (!items.length) return;
  line(`${title}: ${items.length}`);
  for (const item of items.slice(0, SHOW)) line(`  ${show(item)}`);
  if (items.length > SHOW) line(`  … and ${items.length - SHOW} more`);
};

const run = async () => {
  const plan = await CpvClassifierService.plan();
  const { files, full, subset, changes } = plan;

  line(`full list ${files.full.url}: ${full.entries.length} codes on sheet "${full.sheet}", version ${plan.version}`);
  line(`e-auction subset ${files.eauction.url}: ${subset.entries.length} codes on sheet "${subset.sheet}"`);
  for (const [name, parsed] of [['full list', full], ['subset', subset]]) {
    list(`${name} rows skipped`, parsed.skipped, (s) => `row ${s.row} ${s.reason} ${JSON.stringify(s.value)}`);
    list(`${name} names with an undecoded character`, parsed.undecoded, (code) => code);
  }
  list('subset codes the full list lacks (marked e-auction only)', plan.entries.filter((e) => e.eauctionOnly), (e) => `${e.code} ${e.name}`);

  line(`stored version: ${plan.storedVersion ?? 'none'}`);
  list('added', changes.added, (e) => `${e.code} ${e.name}`);
  list('withdrawn (kept, marked)', changes.withdrawn, (r) => `${r.code} ${r.name}`);
  list('restored', changes.restored, (e) => `${e.code} ${e.name}`);
  list('renamed', changes.renamed, (r) => `${r.code} «${r.from}» → «${r.to}»`);
  list('unit changed', changes.unitChanged, (r) => `${r.code} ${r.from ?? '—'} → ${r.to ?? '—'}`);
  list('e-auction-only mark changed', changes.subsetChanged, (r) => `${r.code} → ${r.eauctionOnly}`);
  if (plan.unchanged) line('no changes against the stored version');

  line(`stated CPV codes in the database: ${plan.statedCodes}; the file names all but ${plan.unnamed.length}`);
  list('stated codes the file does not name', plan.unnamed, (s) => `${s.code} (${s.uses} uses)`);

  if (!apply) {
    line(`dry run: nothing written${plan.unchanged ? '' : `; --apply writes version ${plan.version}`}`);
    return;
  }
  const result = await CpvClassifierService.apply(plan);
  line(`applied version ${plan.version}: ${result.written} codes written, ${result.withdrawn} withdrawn`);
};

run()
  .then(() => closeDb().then(() => process.exit(0)))
  .catch(async (error) => {
    logger.error(`[cpv-refresh] aborted: ${error.message}`);
    await closeDb();
    process.exit(1);
  });
