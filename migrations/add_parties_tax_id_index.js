// NPM Modules
import knex from 'knex';
import knexConfigs from '../src/configs/knex.config.js';

/**
 * Ticket 11: `parties_tax_id_idx`. Party resolution looks a bidder up by its
 * ՀՎՀՀ before its per-source id (party.repo.js#upsert), on every PPCM bid
 * written, so the column a lookup runs on gets an index.
 *
 * Deliberately NOT unique: two parties holding one ՀՎՀՀ is a duplicate to
 * report (services/bidderTaxId.service.js), and a unique index would turn the
 * attach that reveals it into a failed job instead. Nothing to fill. Additive
 * and safe to run twice.
 */

async function migrate(pg) {
  await pg.raw('CREATE INDEX IF NOT EXISTS parties_tax_id_idx ON parties (tax_id)');
  const { rows } = await pg.raw("select 1 from pg_indexes where indexname = 'parties_tax_id_idx'");
  return { partiesTaxIdIndex: rows.length === 1 };
}

async function init() {
  const options =
    process.env.NODE_ENV === 'production' ? knexConfigs.production : knexConfigs.development;
  const pg = knex(options);

  try {
    const result = await pg.transaction(migrate);
    console.log('✅ parties_tax_id_idx in place:', result);
    process.exitCode = 0;
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pg.destroy();
  }
}

init();
