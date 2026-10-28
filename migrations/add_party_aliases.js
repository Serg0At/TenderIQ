// NPM Modules
import knex from 'knex';
import knexConfigs from '../src/configs/knex.config.js';

/**
 * Ticket 19: `party_aliases`. Merging two buyers that hold one ՀՎՀՀ removes
 * one party row, and with it the per-source id its source resolves it by
 * (`armeps:buyer:…`). Without this table the next read of that source would
 * create the buyer again and move its tender off the merged party — an
 * amendment of `buyer_id`, alerted. Nothing to fill: rows are written by the
 * merge. Additive and safe to run twice.
 */

async function migrate(pg) {
  await pg.raw(`CREATE TABLE IF NOT EXISTS party_aliases (
    source_id varchar(255) PRIMARY KEY,
    party_id varchar(255) NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
    merged_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pg.raw('CREATE INDEX IF NOT EXISTS party_aliases_party_idx ON party_aliases (party_id)');
  const { rows } = await pg.raw("select 1 from pg_indexes where indexname = 'party_aliases_party_idx'");
  return { partyAliases: rows.length === 1 };
}

async function init() {
  const options =
    process.env.NODE_ENV === 'production' ? knexConfigs.production : knexConfigs.development;
  const pg = knex(options);

  try {
    const result = await pg.transaction(migrate);
    console.log('✅ party_aliases in place:', result);
    process.exitCode = 0;
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pg.destroy();
  }
}

init();
