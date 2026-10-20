// NPM Modules
import knex from 'knex';
import knexConfigs from '../src/configs/knex.config.js';

/**
 * Ticket 17: `tenders.cpv_codes`, every CPV code the tender's source states,
 * beside `cpv_code`, which stays the primary one. Never NULL — "no code
 * recorded" is the empty list, as for saved_searches.cpv_codes. A GIN index,
 * because the discovery filter asks for overlap (`&&`) with a set of codes.
 *
 * Additive and safe to run twice. Existing rows start empty and are filled from
 * storage by `npm run cpv:backfill`, which raises no alert.
 */

async function migrate(pg) {
  const added = !(await pg.schema.hasColumn('tenders', 'cpv_codes'));
  if (added) {
    await pg.schema.alterTable('tenders', table => {
      table.specificType('cpv_codes', 'text[]').notNullable().defaultTo('{}');
    });
  }
  await pg.raw('CREATE INDEX IF NOT EXISTS tenders_cpv_codes_idx ON tenders USING gin (cpv_codes)');
  return { columnAdded: added };
}

async function init() {
  const options =
    process.env.NODE_ENV === 'production' ? knexConfigs.production : knexConfigs.development;
  const pg = knex(options);

  try {
    const result = await pg.transaction(migrate);
    console.log('✅ tenders.cpv_codes in place:', result);
    process.exitCode = 0;
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pg.destroy();
  }
}

init();
