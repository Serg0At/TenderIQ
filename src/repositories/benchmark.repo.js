import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';
import { significantPrefix } from '../libs/cpv.js';

const TABLE = 'price_benchmarks';

/**
 * Comparable awards and the materialised price statistics computed from them.
 *
 * Awards are per LOT, so the category of a comparable is the lot's CPV, falling
 * back to the tender's headline code. Using only `tenders.cpv_code` would
 * mis-file every lot of a multi-category tender — one sampled invitation
 * carried 15 distinct codes across 18 lots.
 */
export default class BenchmarkRepository {
  /**
   * Statistics over comparable awards, computed in the database.
   *
   * Percentiles belong in SQL: pulling every award into Node to sort them costs
   * memory that grows with the corpus, and `percentile_cont` is exact.
   *
   * @param {object} opts
   * @param {string} opts.cpvCode   category to match
   * @param {boolean} opts.exact    true = this code only; false = its family
   * @param {string|null} opts.buyerId  restrict to one buying agency
   * @param {number} opts.sinceMonths   recency window
   */
  static async statsFor({ cpvCode, exact = true, buyerId = null, sinceMonths = 24 }, trx = db) {
    // Family match walks up the CPV hierarchy by stripping trailing zeros:
    // 33141211 -> '33141211%', 33140000 -> '3314%'. A profile for the parent
    // therefore catches its children, never the reverse.
    const prefix = exact ? null : significantPrefix(cpvCode);

    const rows = await trx
      .with('comparable', (qb) => {
        qb.select(
          'a.amount',
          'a.net_amount',
          'a.estimated_value',
          // Carried so the aggregate below can count how many distinct
          // procurements the sample actually represents.
          't.id as tender_id',
          trx.raw('coalesce(l.cpv_code, t.cpv_code) as cpv')
        )
          .from('awards as a')
          .join('tenders as t', 't.id', 'a.tender_id')
          .leftJoin('tender_lots as l', function joinLot() {
            this.on('l.tender_id', '=', 'a.tender_id').andOn('l.lot_number', '=', 'a.lot_number');
          })
          .whereNotNull('a.amount')
          .andWhere('a.amount', '>', 0)
          .andWhereRaw(`t.published_at >= now() - (? || ' months')::interval`, [
            String(Number(sinceMonths)),
          ]);

        if (buyerId) qb.andWhere('t.buyer_id', buyerId);
        if (exact) qb.andWhereRaw('coalesce(l.cpv_code, t.cpv_code) = ?', [cpvCode]);
        else qb.andWhereRaw('coalesce(l.cpv_code, t.cpv_code) like ?', [`${prefix}%`]);
      })
      .select(
        trx.raw('count(*)::int as sample_size'),
        /**
         * Independence. `sample_size` counts awards, which are per LOT, so a
         * single multi-lot procurement can clear the comparables threshold on
         * its own — 33 of them do on the live corpus. A median over 33 lots of
         * one buy is one observation wearing the costume of 33, which is
         * exactly what the threshold exists to prevent, so every benchmark
         * carries the count that distinguishes them.
         */
        trx.raw('count(distinct tender_id)::int as distinct_tenders'),
        /**
         * Price levels WITHOUT VAT; the discount below stays gross.
         *
         * A benchmark answers "what wins", and the auction ranks on the net
         * value. About three quarters of bids carry 20% VAT, so a gross median
         * mixes two price levels a fifth apart, and the recommendation built
         * on it would tell a non-VAT bidder to bid 20% too high. The budget is
         * gross, so the discount is gross against gross.
         */
        trx.raw('min(net_amount)::numeric as min_price'),
        trx.raw('percentile_cont(0.5) within group (order by net_amount)::numeric as median_price'),
        trx.raw('max(net_amount)::numeric as max_price'),
        // Discount is only meaningful where the buyer published an estimate,
        // so rows without one are excluded from that average rather than
        // counted as a 0% discount.
        // Rounded here, at the source. A discount averaged from a few dozen
        // awards is meaningful to about a tenth of a percent; carrying seven
        // decimals implies an accuracy the sample cannot support, and the
        // column was `real` (float4), so the trailing digits were float noise
        // rather than data — 6.8833737 for what is simply 6.88.
        trx.raw(
          `round(
             avg((estimated_value - amount) / nullif(estimated_value, 0) * 100)
               filter (where estimated_value > 0)::numeric
           , 2) as avg_discount_pct`
        )
      )
      .from('comparable')
      .first();

    return {
      sampleSize: Number(rows?.sample_size ?? 0),
      distinctTenders: Number(rows?.distinct_tenders ?? 0),
      minPrice: rows?.min_price === null ? null : Number(rows?.min_price),
      medianPrice: rows?.median_price === null ? null : Number(rows?.median_price),
      maxPrice: rows?.max_price === null ? null : Number(rows?.max_price),
      avgDiscountPct: rows?.avg_discount_pct === null ? null : Number(rows?.avg_discount_pct),
    };
  }

  /**
   * A handful of individual comparable awards — the concrete rows behind the
   * statistic.
   *
   * The AI layer gets these alongside the aggregates so its explanation can
   * cite actual awards rather than paraphrase a median, and so every number in
   * the answer traces to a row a human can look up on the source site.
   *
   * Two constraints make the sample honest, and both were added because the
   * naive query violated them:
   *
   * 1. **One award per tender.** A multi-lot procurement awards the same goods
   *    across many lots at nearly the same price, so ordering by date alone
   *    returned ten rows from a single tender — ten lines that read as ten
   *    independent data points and are one procurement. `distinct on (t.id)`
   *    makes ten comparables mean ten separate buys.
   * 2. **Never the tender being priced.** Without `excludeTenderId` the subject
   *    tender's own award ranks first among its own comparables, and the
   *    recommendation cites the answer back at itself.
   *
   * The representative lot is the lowest-numbered one, chosen for determinism
   * rather than for meaning — picking the cheapest or dearest lot would bias
   * the sample in a direction.
   */
  static async comparableAwards(
    { cpvCode, exact = true, buyerId = null, sinceMonths = 24, limit = 10, excludeTenderId = null },
    trx = db
  ) {
    const prefix = exact ? null : significantPrefix(cpvCode);

    const inner = trx('awards as a')
      // One row per (tender, lot) before joining, so a multi-item lot cannot
      // return the same award several times.
      .with('lot_category', (qb) =>
        qb
          .distinctOn('tender_id', 'lot_number')
          .select('tender_id', 'lot_number', 'cpv_code')
          .from('tender_lots')
          .orderBy([
            { column: 'tender_id' },
            { column: 'lot_number' },
            { column: 'item_sequence' },
          ])
      )
      // Postgres requires the DISTINCT ON expression to lead the ORDER BY, so
      // the recency ordering has to happen in the outer query below.
      .distinctOn('t.id')
      .join('tenders as t', 't.id', 'a.tender_id')
      .join('parties as buyer', 'buyer.id', 't.buyer_id')
      .leftJoin('parties as supplier', 'supplier.id', 'a.supplier_id')
      .leftJoin('lot_category as l', function joinLot() {
        this.on('l.tender_id', '=', 'a.tender_id').andOn('l.lot_number', '=', 'a.lot_number');
      })
      .whereNotNull('a.amount')
      .andWhere('a.amount', '>', 0)
      .andWhereRaw(`t.published_at >= now() - (? || ' months')::interval`, [
        String(Number(sinceMonths)),
      ])
      .select(
        't.id as tender_id',
        't.title',
        't.reference_code',
        't.published_at',
        'buyer.name as buyer_name',
        'supplier.name as supplier_name',
        'a.lot_number',
        'a.amount',
        'a.net_amount',
        'a.estimated_value',
        'a.currency',
        trx.raw('coalesce(l.cpv_code, t.cpv_code) as cpv_code'),
        // Participation, so rejected bids count — this is how contested the
        // lot was, not how many bids survived screening.
        trx.raw(
          `(select count(*) from public_tender_bids b
              where b.tender_id = a.tender_id and b.lot_number = a.lot_number)::int
           as bidder_count`
        )
      )
      .orderBy([{ column: 't.id' }, { column: 'a.lot_number' }]);

    if (buyerId) inner.andWhere('t.buyer_id', buyerId);
    if (excludeTenderId) inner.andWhereNot('t.id', excludeTenderId);
    if (exact) inner.andWhereRaw('coalesce(l.cpv_code, t.cpv_code) = ?', [cpvCode]);
    else inner.andWhereRaw('coalesce(l.cpv_code, t.cpv_code) like ?', [`${prefix}%`]);

    // Newest first: the most recent comparable is the strongest evidence of
    // today's price.
    return trx
      .select('*')
      .from(inner.as('one_per_tender'))
      .orderBy('published_at', 'desc')
      .limit(limit);
  }

  /** Materialised row for a category, optionally narrowed to one buyer. */
  static async find({ cpvCode, buyerId = null }, trx = db) {
    const query = trx(TABLE).where({ cpv_code: cpvCode });
    buyerId ? query.andWhere({ buyer_id: buyerId }) : query.whereNull('buyer_id');
    return query.orderBy('computed_at', 'desc').first();
  }

  /**
   * Replace the stored benchmark for a category.
   *
   * Benchmarks are materialised, never computed per request: the reference
   * requires intelligence reads under 2s, and a percentile over the full award
   * corpus is not a request-time operation.
   */
  static async upsert({ cpvCode, buyerId = null, stats }, trx = db) {
    const existing = await BenchmarkRepository.find({ cpvCode, buyerId }, trx);
    const row = {
      cpv_code: cpvCode,
      buyer_id: buyerId,
      sample_size: stats.sampleSize,
      distinct_tenders: stats.distinctTenders ?? null,
      min_price: stats.minPrice,
      median_price: stats.medianPrice,
      max_price: stats.maxPrice,
      avg_discount_pct: stats.avgDiscountPct,
      computed_at: new Date(),
    };

    if (existing) {
      await trx(TABLE).where({ id: existing.id }).update(row);
      return existing.id;
    }
    const id = createId();
    await trx(TABLE).insert({ id, ...row });
    return id;
  }

  /** Every category that currently has at least one award — the recompute set. */
  static async categoriesWithAwards(trx = db) {
    const rows = await trx('awards as a')
      .join('tenders as t', 't.id', 'a.tender_id')
      .leftJoin('tender_lots as l', function joinLot() {
        this.on('l.tender_id', '=', 'a.tender_id').andOn('l.lot_number', '=', 'a.lot_number');
      })
      .whereNotNull('a.amount')
      .whereRaw('coalesce(l.cpv_code, t.cpv_code) is not null')
      .distinct(trx.raw('coalesce(l.cpv_code, t.cpv_code) as cpv'));
    return rows.map((r) => r.cpv);
  }

  /**
   * (category, buyer) pairs that already hold enough awards to clear the
   * comparables threshold.
   *
   * The pre-filter is the whole point. `categoriesWithAwards` returns ~600
   * categories and there are 222 buyers; recomputing the cross product would be
   * 130,000 statistics queries a night to publish a few hundred rows. Asking
   * the database which pairs *could* clear the bar first turns that into one
   * aggregate plus one query per pair that will actually be stored.
   *
   * `buyer_exact_cpv` is the strongest tier the benchmark service has — the
   * same agency buying the same thing is the same market — but until now it was
   * only ever computed live, on request, for whichever tender someone happened
   * to open. Materialising it is what makes the strongest answer the fast one.
   *
   * The window and the count rule are kept identical to `statsFor`, or this
   * would nominate pairs that then fail to clear the threshold it just
   * predicted they would.
   */
  static async buyerCategoryPairs(
    { minCount = 5, sinceMonths = 24 } = {},
    trx = db
  ) {
    const rows = await trx('awards as a')
      // Collapsed to one row per (tender, lot) first: a `tender_lots` row is
      // one ITEM, so joining straight to it would count an award once per item
      // and nominate pairs on inflated counts.
      .with('lot_category', (qb) =>
        qb
          .distinctOn('tender_id', 'lot_number')
          .select('tender_id', 'lot_number', 'cpv_code')
          .from('tender_lots')
          .orderBy([
            { column: 'tender_id' },
            { column: 'lot_number' },
            { column: 'item_sequence' },
          ])
      )
      .join('tenders as t', 't.id', 'a.tender_id')
      .leftJoin('lot_category as l', function joinLot() {
        this.on('l.tender_id', '=', 'a.tender_id').andOn('l.lot_number', '=', 'a.lot_number');
      })
      .whereNotNull('a.amount')
      .andWhere('a.amount', '>', 0)
      .whereNotNull('t.buyer_id')
      .andWhereRaw('coalesce(l.cpv_code, t.cpv_code) is not null')
      .andWhereRaw(`t.published_at >= now() - (? || ' months')::interval`, [
        String(Number(sinceMonths)),
      ])
      .groupByRaw('coalesce(l.cpv_code, t.cpv_code), t.buyer_id')
      .havingRaw('count(*) >= ?', [Number(minCount)])
      .select(
        trx.raw('coalesce(l.cpv_code, t.cpv_code) as cpv'),
        't.buyer_id',
        trx.raw('count(*)::int as award_count')
      );

    return rows.map((r) => ({
      cpvCode: r.cpv,
      buyerId: r.buyer_id,
      awardCount: Number(r.award_count),
    }));
  }

  /** The categories one tender touches — the set to refresh after it settles. */
  static async categoriesForTender(tenderId, trx = db) {
    const rows = await trx('tenders as t')
      .leftJoin('tender_lots as l', 'l.tender_id', 't.id')
      .where('t.id', tenderId)
      .distinct(trx.raw('coalesce(l.cpv_code, t.cpv_code) as cpv'));
    return rows.map((r) => r.cpv).filter(Boolean);
  }
}
