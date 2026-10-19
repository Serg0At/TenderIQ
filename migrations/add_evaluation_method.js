// NPM Modules
import knex from 'knex';
import knexConfigs from '../src/configs/knex.config.js';

/**
 * Ticket 05: `tenders.evaluation_method`, how the buyer picks the winner
 * (`lowest_price`, …), as armeps.am states it on every CfT page. Nullable:
 * e-auction pages state none, and none is filled in for them.
 *
 * Additive and safe to run twice. Nothing writes the column until the code
 * that ships with it is deployed.
 */

async function migrate(pg) {
  const added = !(await pg.schema.hasColumn('tenders', 'evaluation_method'));
  if (added) {
    await pg.schema.alterTable('tenders', table => {
      table.string('evaluation_method');
    });
  }
  return { columnAdded: added };
}

async function init() {
  const options =
    process.env.NODE_ENV === 'production' ? knexConfigs.production : knexConfigs.development;
  const pg = knex(options);

  try {
    const result = await pg.transaction(migrate);
    console.log('✅ tenders.evaluation_method in place:', result);
    process.exitCode = 0;
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pg.destroy();
  }
}

init();
