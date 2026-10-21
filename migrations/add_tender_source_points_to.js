// NPM Modules
import knex from 'knex';
import knexConfigs from '../src/configs/knex.config.js';

/**
 * Ticket 07: `tender_sources.points_to`, the link a discovery link is a notice
 * of (`{source}:{external id}`, e.g. `gnumner:<invitation hash>` or
 * `armeps:<resourceId>`). Once a re-posted paper invitation joins its run, one
 * tender holds the notices of two files, and a replay must count each file's
 * deadline from its own notice — which only this says.
 *
 * Fills existing rows from what they already imply: a gnumner ARMEPS notice
 * (`armeps:<resourceId>`) points at that id, and a paper notice (`paper:…`)
 * at its tender's one invitation file — every paper tender holds exactly one
 * before this ticket, and a tender holding more is left blank rather than
 * guessed. Additive and safe to run twice.
 */

async function migrate(pg) {
  const added = !(await pg.schema.hasColumn('tender_sources', 'points_to'));
  if (added) {
    await pg.schema.alterTable('tender_sources', table => {
      table.string('points_to');
    });
  }
  await pg.raw(`CREATE INDEX IF NOT EXISTS tender_sources_points_to_idx
     ON tender_sources (source, points_to) WHERE points_to IS NOT NULL`);

  const armeps = await pg.raw(`
    UPDATE tender_sources SET points_to = external_id
     WHERE source = 'gnumner' AND external_id LIKE 'armeps:%' AND points_to IS NULL`);

  const paper = await pg.raw(`
    UPDATE tender_sources n SET points_to = 'gnumner:' || d.external_id
      FROM tender_sources d
     WHERE n.source = 'gnumner' AND n.external_id LIKE 'paper:%' AND n.points_to IS NULL
       AND d.tender_id = n.tender_id AND d.source = 'gnumner' AND d.role = 'detail'
       AND d.external_id ~ '^[0-9a-f]{64}$'
       AND (SELECT count(*) FROM tender_sources o
             WHERE o.tender_id = n.tender_id AND o.source = 'gnumner' AND o.role = 'detail'
               AND o.external_id ~ '^[0-9a-f]{64}$') = 1`);

  const blank = await pg('tender_sources')
    .where({ source: 'gnumner', role: 'discovery' })
    // An amendment notice (`amendment:…`) is a discovery link that points at nothing.
    .whereNot('external_id', 'like', 'amendment:%')
    .whereNull('points_to')
    .count('* as c')
    .first();

  return {
    columnAdded: added,
    armepsNotices: armeps.rowCount,
    paperNotices: paper.rowCount,
    discoveryLinksStillBlank: Number(blank.c),
  };
}

async function init() {
  const options =
    process.env.NODE_ENV === 'production' ? knexConfigs.production : knexConfigs.development;
  const pg = knex(options);

  try {
    const result = await pg.transaction(migrate);
    console.log('✅ tender_sources.points_to in place:', result);
    process.exitCode = 0;
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pg.destroy();
  }
}

init();
