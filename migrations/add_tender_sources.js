// NPM Modules
import knex from 'knex';
import knexConfigs from '../src/configs/knex.config.js';
import { getSourceConfig } from '../src/configs/sources.config.js';

/**
 * ADR 0004, ticket 02: every tender knows its submission channel and every
 * source it came from.
 *
 * - `tenders.submission_channel`, NOT NULL, CHECK in (eauction, armeps, paper),
 *   with every existing row backfilled to `eauction` — the only source today.
 *   No column default: a future source that forgets to say which channel it
 *   saw must fail its insert, not silently file a paper tender as an e-auction.
 * - `tender_sources`, one row per (source, external_id) link, and one
 *   `eauction` link for every existing tender (external id = the tid).
 *
 * Additive and safe to run twice. Run it with the workers stopped, before the
 * code that writes `submission_channel` is deployed — that code cannot insert
 * a tender into a table without the column, and the old code cannot insert
 * one into a table where it is NOT NULL without a default.
 */

const SOURCE = 'eauction';

async function hasConstraint(pg, name) {
  const { rows } = await pg.raw('SELECT 1 FROM pg_constraint WHERE conname = ?', [name]);
  return rows.length > 0;
}

async function migrate(pg) {
  await pg.raw('ALTER TABLE tenders ADD COLUMN IF NOT EXISTS submission_channel varchar(255)');
  const channels = await pg.raw(
    `UPDATE tenders SET submission_channel = ? WHERE submission_channel IS NULL AND source_id LIKE ?`,
    [SOURCE, `${SOURCE}:%`]
  );
  await pg.raw('ALTER TABLE tenders ALTER COLUMN submission_channel SET NOT NULL');
  if (!(await hasConstraint(pg, 'tenders_submission_channel_chk'))) {
    await pg.raw(`ALTER TABLE tenders ADD CONSTRAINT tenders_submission_channel_chk
       CHECK (submission_channel IN ('eauction','armeps','paper'))`);
  }
  await pg.raw(`CREATE INDEX IF NOT EXISTS tenders_submission_channel_idx
     ON tenders (submission_channel)`);

  await pg.raw(`CREATE TABLE IF NOT EXISTS tender_sources (
     id varchar(255) PRIMARY KEY,
     tender_id varchar(255) NOT NULL
       CONSTRAINT tender_sources_tender_id_foreign REFERENCES tenders (id) ON DELETE CASCADE,
     source varchar(255) NOT NULL,
     external_id varchar(255) NOT NULL,
     url text,
     role varchar(255) NOT NULL,
     observed_status varchar(255),
     first_seen_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
     last_seen_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`);
  if (!(await hasConstraint(pg, 'tender_sources_source_external_uq'))) {
    await pg.raw(`ALTER TABLE tender_sources ADD CONSTRAINT tender_sources_source_external_uq
       UNIQUE (source, external_id)`);
  }
  if (!(await hasConstraint(pg, 'tender_sources_role_chk'))) {
    await pg.raw(`ALTER TABLE tender_sources ADD CONSTRAINT tender_sources_role_chk
       CHECK (role IN ('discovery','detail','results'))`);
  }
  await pg.raw('CREATE INDEX IF NOT EXISTS tender_sources_tender_idx ON tender_sources (tender_id)');

  // First and last seen come from the stored detail payloads where there are
  // any: that is when the page was actually fetched. `fetched_at` is a lower
  // bound on last seen — an unchanged page is never re-inserted — and the next
  // detail fetch moves it forward.
  const links = await pg.raw(
    `INSERT INTO tender_sources
       (id, tender_id, source, external_id, url, role, observed_status, first_seen_at, last_seen_at)
     SELECT substr(md5(random()::text || t.id), 1, 24),
            t.id, ?, x.tid, ? || x.tid || '/', 'detail', t.source_status,
            coalesce(p.first_at, now()), coalesce(p.last_at, now())
       FROM tenders t
      CROSS JOIN LATERAL (SELECT substr(t.source_id, length(?) + 2) AS tid) x
       LEFT JOIN LATERAL (
            SELECT min(fetched_at) AS first_at, max(fetched_at) AS last_at
              FROM source_payloads sp
             WHERE sp.source = ? AND sp.ref = 'detail:' || x.tid
       ) p ON true
      WHERE t.source_id LIKE ?
     ON CONFLICT (source, external_id) DO NOTHING`,
    [SOURCE, getSourceConfig(SOURCE).detailBaseUrl, SOURCE, SOURCE, `${SOURCE}:%`]
  );

  return { channelsBackfilled: channels.rowCount, linksCreated: links.rowCount };
}

async function init() {
  const options =
    process.env.NODE_ENV === 'production' ? knexConfigs.production : knexConfigs.development;
  const pg = knex(options);

  try {
    const result = await pg.transaction(migrate);
    console.log('✅ tender_sources and submission_channel in place:', result);
    process.exitCode = 0;
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pg.destroy();
  }
}

init();
