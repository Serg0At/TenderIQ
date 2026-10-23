// NPM Modules
import knex from 'knex';
import knexConfigs from '../src/configs/knex.config.js';

/**
 * Ticket 09: `tender_sources.failed_lots`, the lots a gnumner failed-procedure
 * notice declared failed (`integer[]`, NULL on every other link). A notice
 * names the lots that failed, not the tender: a tender is cancelled only once
 * its notices, together, name every lot it has, so each notice's own list has
 * to be kept beside its link — a partly failed procedure is not a cancelled one.
 *
 * Nothing to fill: no failed-procedure notice was linked before this ticket.
 * Additive and safe to run twice.
 */

async function migrate(pg) {
  const added = !(await pg.schema.hasColumn('tender_sources', 'failed_lots'));
  if (added) {
    await pg.schema.alterTable('tender_sources', table => {
      table.specificType('failed_lots', 'integer[]');
    });
  }
  return { failedLotsAdded: added };
}

async function init() {
  const options =
    process.env.NODE_ENV === 'production' ? knexConfigs.production : knexConfigs.development;
  const pg = knex(options);

  try {
    const result = await pg.transaction(migrate);
    console.log('✅ tender_sources.failed_lots in place:', result);
    process.exitCode = 0;
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pg.destroy();
  }
}

init();
