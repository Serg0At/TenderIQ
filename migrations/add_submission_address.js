// NPM Modules
import knex from 'knex';
import knexConfigs from '../src/configs/knex.config.js';

/**
 * Ticket 06: `tenders.submission_address`, where a paper bid is delivered —
 * the address a paper invitation names in its submission sentence («…
 * ներկայացնել <address> հասցեով, փաստաթղթային ձևով …»). Nullable: e-auction
 * and ARMEPS bids are submitted online and have none.
 *
 * Additive and safe to run twice. Nothing writes the column until the code
 * that ships with it is deployed.
 */

async function migrate(pg) {
  const added = !(await pg.schema.hasColumn('tenders', 'submission_address'));
  if (added) {
    await pg.schema.alterTable('tenders', table => {
      table.text('submission_address');
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
    console.log('✅ tenders.submission_address in place:', result);
    process.exitCode = 0;
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pg.destroy();
  }
}

init();
