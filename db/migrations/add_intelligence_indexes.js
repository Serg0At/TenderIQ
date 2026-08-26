// NPM Modules
import knex from 'knex';
import knexConfigs from '../../src/configs/knex.config.js';

/**
 * Additive index migration for the intelligence layer (phase 3).
 *
 * Separate from `create_table.js` because that script is all-or-nothing: it
 * builds the whole schema in one transaction and is not idempotent, so it
 * cannot be re-run against a database that already holds 2,590 tenders and
 * 65,075 bids. This adds only what the new read paths need, and every
 * statement is `IF NOT EXISTS`, so running it twice is a no-op.
 *
 * `create_table.js` carries the same indexes so a fresh database gets them
 * without this script — the two must be kept in step.
 *
 * Why these five:
 *
 *   - Supplier and buyer profiles filter by party. `awards.supplier_id`,
 *     `public_tender_bids.supplier_id` and `tenders.buyer_id` had no index at
 *     all, so every profile read was a sequential scan. It is survivable at
 *     today's size and it is not at the finished corpus (~773k bids), and the
 *     endpoint has a 2s budget (NFR-PERF-3).
 *   - `price_benchmarks` had only its primary key, so the per-request
 *     `find({ cpvCode, buyerId })` scanned the table. Buyer-specific
 *     materialisation multiplies that table's row count by the number of
 *     buyer/category pairs that clear the threshold, which makes the scan
 *     progressively worse exactly as the feature succeeds.
 *
 * CONCURRENTLY is deliberately NOT used: it cannot run inside a transaction,
 * and these tables are small enough that a brief write lock during a deploy
 * costs less than the added failure modes of an invalid half-built index.
 */
const STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS awards_supplier_idx
     ON awards (supplier_id)`,

  `CREATE INDEX IF NOT EXISTS public_tender_bids_supplier_idx
     ON public_tender_bids (supplier_id)`,

  `CREATE INDEX IF NOT EXISTS tenders_buyer_idx
     ON tenders (buyer_id)`,

  // Not unique: a NULL never collides in a Postgres unique index, so a unique
  // constraint here would silently permit duplicate global (buyer-less)
  // benchmark rows — the exact trap tender_lots documents. The repository
  // arbitrates instead; this index only makes the lookup cheap.
  `CREATE INDEX IF NOT EXISTS price_benchmarks_cpv_buyer_idx
     ON price_benchmarks (cpv_code, buyer_id)`,

  // The competitor-price read walks one tender's whole ledger ordered by lot
  // then rank. Leading column matches the existing tender index, so this
  // replaces a sort rather than a scan.
  `CREATE INDEX IF NOT EXISTS public_tender_bids_tender_lot_rank_idx
     ON public_tender_bids (tender_id, lot_number, rank)`,

  /**
   * How many DISTINCT TENDERS a benchmark's comparables came from.
   *
   * `sample_size` counts awards, and awards are per lot, so a single multi-lot
   * procurement can satisfy the comparables threshold on its own. Measured on
   * the live corpus: of the 55 categories that clear `MIN_COMPARABLES = 5`, 47
   * draw from fewer than five distinct tenders and 15 draw from exactly one —
   * CPV 33141205 reports 33 comparable awards that are 33 lots of one buy.
   *
   * A median over 33 lots of one procurement is one observation, not 33, and
   * the threshold exists precisely to stop a number like that being presented
   * as a statistic. This column makes the distinction visible everywhere a
   * benchmark is read, including from the materialised table.
   */
  `ALTER TABLE price_benchmarks ADD COLUMN IF NOT EXISTS distinct_tenders integer`,
];

const run = async () => {
  const options =
    process.env.NODE_ENV === 'production' ? knexConfigs.production : knexConfigs.development;
  const pg = knex(options);
  try {
    await pg.transaction(async (trx) => {
      for (const sql of STATEMENTS) {
        await trx.raw(sql);
        console.log(`  ok  ${sql.trim().split('\n')[0]}`);
      }
    });
    console.log('intelligence indexes applied');
  } finally {
    await pg.destroy();
  }
};

run().catch((error) => {
  console.error('index migration failed:', error.message);
  process.exit(1);
});
