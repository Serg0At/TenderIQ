// NPM Modules
import knex from 'knex';
import knexConfigs from '../src/configs/knex.config.js';

/**
 * Ticket 10 follow-up: `price_benchmarks.discount_excluded`, how many awards
 * with a budget the stored `avg_discount_pct` left out because their contract
 * is not the winning offer (a PPCM framework or partial-funds contract,
 * tender.repo.js#awardOfferSql). A discount compares the offer, never the
 * contract, and a lot it cannot compare is counted rather than given a gross.
 *
 * Nothing to fill: NULL reads as "computed before the count was kept", and
 * the nightly recompute writes it for every category it stores. Additive and
 * safe to run twice.
 */

async function migrate(pg) {
  const added = !(await pg.schema.hasColumn('price_benchmarks', 'discount_excluded'));
  if (added) {
    await pg.schema.alterTable('price_benchmarks', table => {
      table.integer('discount_excluded');
    });
  }
  return { discountExcludedAdded: added };
}

async function init() {
  const options =
    process.env.NODE_ENV === 'production' ? knexConfigs.production : knexConfigs.development;
  const pg = knex(options);

  try {
    const result = await pg.transaction(migrate);
    console.log('✅ price_benchmarks.discount_excluded in place:', result);
    process.exitCode = 0;
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pg.destroy();
  }
}

init();
