// NPM Modules
import knex from 'knex';
import knexConfigs from '../src/configs/knex.config.js';

/**
 * Ticket 32: `supplier_identities`, the set of parties an organization bids
 * as, replacing `organizations.supplier_party_id`. Every claim the column
 * held moves into the table, then the column and its partial unique index
 * are dropped — two stores of "who are we" would be two answers. A party is
 * still claimable by one organization only (`supplier_identities_party_uq`).
 *
 * Additive and safe to run twice: the copy runs only while the column still
 * exists, and inserts nothing already there.
 */

async function migrate(pg) {
  await pg.raw(`CREATE TABLE IF NOT EXISTS supplier_identities (
    id varchar(255) PRIMARY KEY,
    organization_id varchar(255) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    party_id varchar(255) NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
    claimed_by varchar(255) REFERENCES users(id) ON DELETE SET NULL,
    claimed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const { rows: constraint } = await pg.raw(
    "select 1 from pg_constraint where conname = 'supplier_identities_party_uq'"
  );
  if (!constraint.length) {
    await pg.raw('ALTER TABLE supplier_identities ADD CONSTRAINT supplier_identities_party_uq UNIQUE (party_id)');
  }
  await pg.raw('CREATE INDEX IF NOT EXISTS supplier_identities_org_idx ON supplier_identities (organization_id)');

  let copied = 0;
  const { rows: column } = await pg.raw(
    "select 1 from information_schema.columns where table_name = 'organizations' and column_name = 'supplier_party_id'"
  );
  if (column.length) {
    // The claim's id is derived from the organization's, so a re-run of a
    // half-finished copy is a conflict and not a second row.
    const result = await pg.raw(`
      INSERT INTO supplier_identities (id, organization_id, party_id, claimed_by)
      SELECT 'claim-' || o.id, o.id, o.supplier_party_id, NULL
        FROM organizations o
       WHERE o.supplier_party_id IS NOT NULL
      ON CONFLICT DO NOTHING`);
    copied = result.rowCount;
    await pg.raw('DROP INDEX IF EXISTS organizations_supplier_party_uq');
    await pg.raw('ALTER TABLE organizations DROP COLUMN supplier_party_id');
  }

  const { rows } = await pg.raw('select count(*)::int as n from supplier_identities');
  return { claimsCopied: copied, claims: rows[0].n, columnDropped: column.length === 1 };
}

async function init() {
  const options =
    process.env.NODE_ENV === 'production' ? knexConfigs.production : knexConfigs.development;
  const pg = knex(options);

  try {
    const result = await pg.transaction(migrate);
    console.log('✅ supplier_identities in place:', result);
    process.exitCode = 0;
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pg.destroy();
  }
}

init();
