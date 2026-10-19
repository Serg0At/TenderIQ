// NPM Modules
import knex from 'knex';
import knexConfigs from '../src/configs/knex.config.js';

/**
 * ADR 0004, ticket 03: `unmatched_results`, where a result that cannot be
 * attached to exactly one tender is kept with its reason and counted.
 *
 * The table is built with the same Knex builder calls as create_table.js, so
 * the migrated database and a fresh one cannot drift apart on names or
 * defaults. Additive and safe to run twice. Nothing writes the table until the
 * code that ships with it is deployed, so order does not matter here.
 */

async function hasConstraint(pg, name) {
  const { rows } = await pg.raw('SELECT 1 FROM pg_constraint WHERE conname = ?', [name]);
  return rows.length > 0;
}

async function migrate(pg) {
  const created = !(await pg.schema.hasTable('unmatched_results'));
  if (created) {
    await pg.schema.createTable('unmatched_results', table => {
      table.string('id').primary();
      table.string('source').notNullable();
      table.string('external_ref').notNullable();
      table.string('procedure_code');
      table.string('reason').notNullable();
      table.specificType('candidate_tender_ids', 'text[]').notNullable().defaultTo('{}');
      table.string('payload_hash').notNullable();
      table.timestamp('first_seen_at').notNullable().defaultTo(pg.fn.now());
      table.timestamp('last_seen_at').notNullable().defaultTo(pg.fn.now());
      table.string('resolved_tender_id').references('id').inTable('tenders').onDelete('SET NULL');
      table.timestamp('resolved_at');
      table.unique(['source', 'external_ref'], { indexName: 'unmatched_results_source_ref_uq' });
    });
  }
  if (!(await hasConstraint(pg, 'unmatched_results_reason_chk'))) {
    await pg.raw(`ALTER TABLE unmatched_results ADD CONSTRAINT unmatched_results_reason_chk
       CHECK (reason IN ('no_candidate','ambiguous','no_code','unsupported_format'))`);
  }
  return { tableCreated: created };
}

async function init() {
  const options =
    process.env.NODE_ENV === 'production' ? knexConfigs.production : knexConfigs.development;
  const pg = knex(options);

  try {
    const result = await pg.transaction(migrate);
    console.log('✅ unmatched_results in place:', result);
    process.exitCode = 0;
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pg.destroy();
  }
}

init();
