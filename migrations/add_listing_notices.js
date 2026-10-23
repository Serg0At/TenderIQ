// NPM Modules
import knex from 'knex';
import knexConfigs from '../src/configs/knex.config.js';

/**
 * Ticket 31: what Tendra needs to tell a contract notice of a procedure that
 * was never public from one whose tender it missed.
 *
 * `listing_notices` — every notice on gnumner's invitation listings, with the
 * code its title names and when it was published. "No invitation of this code
 * was ever seen" has to be asked of the notices themselves: a notice whose
 * job failed, or whose file nobody could read, leaves no tender behind, and
 * its code is still a fact. Filled for new notices by the listing chain; for
 * pages already stored, `npm run notices:backfill`.
 *
 * `unmatched_results.procedure_type` and `.was_public` — so the unreadable
 * count can be split into single-source and competitive, and a `no_candidate`
 * that Tendra missed (`was_public` true) told from one nobody can know about
 * (null) and one that was never public (false).
 *
 * Additive and safe to run twice.
 */

async function migrate(pg) {
  const created = !(await pg.schema.hasTable('listing_notices'));
  if (created) {
    await pg.schema.createTable('listing_notices', table => {
      table.string('id').primary();
      table.string('source').notNullable();
      table.string('external_id').notNullable();
      table.string('listing').notNullable();
      table.string('procedure_code');
      table.timestamp('published_at').notNullable();
      table.timestamp('first_seen_at').notNullable().defaultTo(pg.fn.now());
      table.unique(['source', 'external_id'], { indexName: 'listing_notices_source_external_uq' });
    });
  }
  await pg.raw(`CREATE INDEX IF NOT EXISTS listing_notices_published_idx
     ON listing_notices (source, published_at)`);

  const typeAdded = !(await pg.schema.hasColumn('unmatched_results', 'procedure_type'));
  if (typeAdded) {
    await pg.schema.alterTable('unmatched_results', table => {
      table.string('procedure_type');
    });
  }
  const publicAdded = !(await pg.schema.hasColumn('unmatched_results', 'was_public'));
  if (publicAdded) {
    await pg.schema.alterTable('unmatched_results', table => {
      table.boolean('was_public');
    });
  }

  return { listingNoticesCreated: created, procedureTypeAdded: typeAdded, wasPublicAdded: publicAdded };
}

async function init() {
  const options =
    process.env.NODE_ENV === 'production' ? knexConfigs.production : knexConfigs.development;
  const pg = knex(options);

  try {
    const result = await pg.transaction(migrate);
    console.log('✅ listing_notices and unmatched_results.{procedure_type,was_public} in place:', result);
    process.exitCode = 0;
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pg.destroy();
  }
}

init();
