import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';

const BUYER_TABLE = 'buyer_profiles';
const SUPPLIER_TABLE = 'supplier_profiles';

/**
 * Aggregated behaviour of the two sides of the market: what a buying agency
 * buys and from whom, and how a competing supplier bids and wins.
 *
 * Everything here is derived from published public record — `tenders`,
 * `awards`, `public_tender_bids`, `parties`. No tenant-private data is read,
 * and a profile is identical for every customer who asks.
 *
 * The two counting rules from `publicBid.repo.js` hold throughout and decide
 * almost every query below:
 *
 *   - **Participation counts include rejected bids.** A supplier that submitted
 *     and was disqualified still bid and still lost, so it belongs in the
 *     denominator of a win rate. Excluding rejects would inflate every win rate
 *     in the system.
 *   - **Money statistics exclude them.** Rejected submissions carry real but
 *     unusable figures, and averaging them in moved the mean bid by a factor of
 *     107,000.
 *
 * Recency defaults to ALL time rather than the benchmark window. A price goes
 * stale — what a thing cost two years ago is weak evidence of what it costs
 * today — but a win rate does not, and a supplier that bid forty times over
 * four years is better characterised by all forty. `sinceMonths` is still
 * accepted so a caller can ask the narrower question.
 */

/** One row per (tender, lot) — see the note in publicBid.repo.js on fanout. */
const lotCategoryCte = (qb) =>
  qb.distinctOn('tender_id', 'lot_number')
    .select('tender_id', 'lot_number', 'cpv_code')
    .from('tender_lots')
    .orderBy([{ column: 'tender_id' }, { column: 'lot_number' }, { column: 'item_sequence' }]);

/** Applies the optional recency window. Null means the whole archive. */
const withinWindow = (qb, sinceMonths, column = 't.published_at') => {
  if (sinceMonths === null || sinceMonths === undefined) return qb;
  return qb.andWhereRaw(`${column} >= now() - (? || ' months')::interval`, [
    String(Number(sinceMonths)),
  ]);
};

const num = (value) => (value === null || value === undefined ? null : Number(value));
const int = (value) => Number(value ?? 0);

export default class ProfileRepository {
  // ---------------------------------------------------------------- supplier

  /**
   * Everything known about how one competitor bids.
   *
   * Four queries rather than one: they aggregate over different grains (bids,
   * awards, categories, rivals) and folding them together would need nested
   * subqueries whose join fanout is exactly the class of bug that put 21% of
   * awards on the wrong company. Four indexed lookups on one supplier are
   * comfortably inside the 2s intelligence budget.
   */
  static async computeSupplier(supplierId, { sinceMonths = null } = {}, trx = db) {
    const [activity, wins, categories, rivals] = await Promise.all([
      // Participation — every bid, rejected included.
      withinWindow(
        trx('public_tender_bids as b')
          .join('tenders as t', 't.id', 'b.tender_id')
          .where('b.supplier_id', supplierId),
        sinceMonths
      )
        .select(
          // The unique key is (tender, lot, supplier, source), so one row IS
          // one lot bid on and count(*) needs no DISTINCT.
          trx.raw('count(*)::int as lots_bid'),
          trx.raw(`count(*) filter (where b.status = 'accepted')::int as lots_accepted`),
          trx.raw(`count(*) filter (where b.status = 'rejected')::int as lots_rejected`),
          trx.raw('count(distinct b.tender_id)::int as tenders_bid'),
          trx.raw('min(t.published_at) as first_seen'),
          trx.raw('max(t.published_at) as last_seen'),
          // Money: accepted only, and only where a budget exists to compare
          // against — a missing budget is not a 0% discount.
          trx.raw(
            `round(avg((b.budget_price - b.final_offer_price) / nullif(b.budget_price, 0) * 100)
               filter (where b.status = 'accepted' and b.budget_price > 0)::numeric, 2)
             as avg_discount_pct`
          )
        )
        .first(),

      withinWindow(
        trx('awards as a')
          .join('tenders as t', 't.id', 'a.tender_id')
          .where('a.supplier_id', supplierId),
        sinceMonths
      )
        .select(
          trx.raw('count(*)::int as lots_won'),
          trx.raw('count(distinct a.tender_id)::int as tenders_won'),
          trx.raw('sum(a.amount)::numeric as total_won'),
          trx.raw('max(a.amount)::numeric as largest_win'),
          trx.raw(
            `round(avg((a.estimated_value - a.amount) / nullif(a.estimated_value, 0) * 100)
               filter (where a.estimated_value > 0)::numeric, 2)
             as avg_winning_discount_pct`
          )
        )
        .first(),

      // Categories need a CPV, which exists for roughly a third of the corpus.
      // A supplier with none gets an empty list, not a wrong one.
      withinWindow(
        trx('public_tender_bids as b')
          .with('lot_category', lotCategoryCte)
          .join('tenders as t', 't.id', 'b.tender_id')
          .leftJoin('lot_category as l', function joinLot() {
            this.on('l.tender_id', '=', 'b.tender_id').andOn('l.lot_number', '=', 'b.lot_number');
          })
          .where('b.supplier_id', supplierId)
          .whereRaw('coalesce(l.cpv_code, t.cpv_code) is not null'),
        sinceMonths
      )
        .groupByRaw('coalesce(l.cpv_code, t.cpv_code)')
        .select(
          trx.raw('coalesce(l.cpv_code, t.cpv_code) as cpv_code'),
          trx.raw('count(*)::int as lots_bid')
        )
        .orderByRaw('count(*) desc')
        .limit(50),

      ProfileRepository.rivalsFor(supplierId, { sinceMonths }, trx),
    ]);

    return { activity, wins, categories, rivals };
  }

  /**
   * The competitors this supplier most often finds itself bidding against.
   *
   * A self-join on the ledger over shared lots. `won_head_to_head` counts lots
   * where the rival took the award and this supplier did not — the answer to
   * "who keeps beating me", which is the question a supplier actually has.
   */
  static async rivalsFor(supplierId, { sinceMonths = null, limit = 5 } = {}, trx = db) {
    const rows = await withinWindow(
      trx('public_tender_bids as mine')
        .join('public_tender_bids as theirs', function sameLot() {
          this.on('theirs.tender_id', '=', 'mine.tender_id')
            .andOn('theirs.lot_number', '=', 'mine.lot_number')
            .andOn('theirs.source', '=', 'mine.source')
            .andOn('theirs.supplier_id', '!=', 'mine.supplier_id');
        })
        .join('tenders as t', 't.id', 'mine.tender_id')
        .join('parties as p', 'p.id', 'theirs.supplier_id')
        .leftJoin('awards as a', function awardOfLot() {
          this.on('a.tender_id', '=', 'mine.tender_id')
            .andOn('a.lot_number', '=', 'mine.lot_number')
            .andOn('a.source', '=', 'mine.source');
        })
        .where('mine.supplier_id', supplierId),
      sinceMonths
    )
      .groupBy('theirs.supplier_id', 'p.name')
      .select(
        'theirs.supplier_id',
        'p.name',
        trx.raw('count(*)::int as shared_lots'),
        trx.raw('count(*) filter (where a.supplier_id = theirs.supplier_id)::int as they_won'),
        trx.raw('count(*) filter (where a.supplier_id = mine.supplier_id)::int as we_won')
      )
      .orderByRaw('count(*) desc')
      .limit(limit);

    return rows.map((r) => ({
      supplierId: r.supplier_id,
      name: r.name,
      sharedLots: int(r.shared_lots),
      theyWon: int(r.they_won),
      weWon: int(r.we_won),
    }));
  }

  // ------------------------------------------------------------------- buyer

  /**
   * How one buying agency behaves: what it spends, how much competition its
   * tenders attract, and which suppliers keep winning them.
   *
   * The last of those is reported as counted evidence and nothing more. A
   * supplier winning a buyer's work repeatedly is a fact with many innocent
   * explanations — it may be the only firm in the region that does the work —
   * and this data cannot distinguish between them. The presentation layer is
   * required to keep it that way.
   */
  static async computeBuyer(buyerId, { sinceMonths = null } = {}, trx = db) {
    const [volume, spend, competition, suppliers] = await Promise.all([
      withinWindow(trx('tenders as t').where('t.buyer_id', buyerId), sinceMonths)
        .select(
          trx.raw('count(*)::int as tender_count'),
          trx.raw('sum(t.estimated_value)::numeric as total_estimated'),
          trx.raw('min(t.published_at) as first_seen'),
          trx.raw('max(t.published_at) as last_seen')
        )
        .first(),

      withinWindow(
        trx('awards as a').join('tenders as t', 't.id', 'a.tender_id').where('t.buyer_id', buyerId),
        sinceMonths
      )
        .select(
          trx.raw('count(*)::int as lots_awarded'),
          trx.raw('count(distinct a.tender_id)::int as tenders_awarded'),
          trx.raw('sum(a.amount)::numeric as total_spend'),
          trx.raw('sum(a.estimated_value)::numeric as total_budget'),
          trx.raw('count(distinct a.supplier_id)::int as distinct_winners'),
          trx.raw(
            `round(avg((a.estimated_value - a.amount) / nullif(a.estimated_value, 0) * 100)
               filter (where a.estimated_value > 0)::numeric, 2)
             as avg_discount_pct`
          )
        )
        .first(),

      // Participation, so rejected bids count.
      trx
        .with('lot_bidders', (qb) => {
          withinWindow(
            qb
              .select('b.tender_id', 'b.lot_number')
              .count('* as n')
              .from('public_tender_bids as b')
              .join('tenders as t', 't.id', 'b.tender_id')
              .where('t.buyer_id', buyerId),
            sinceMonths
          ).groupBy('b.tender_id', 'b.lot_number');
        })
        .select(
          trx.raw('count(*)::int as sample_lots'),
          trx.raw('round(avg(n), 1)::numeric as avg_bidders'),
          trx.raw('percentile_cont(0.5) within group (order by n)::numeric as median_bidders'),
          trx.raw('count(*) filter (where n = 1)::int as sole_bidder_lots')
        )
        .from('lot_bidders')
        .first(),

      ProfileRepository.topSuppliersForBuyer(buyerId, { sinceMonths }, trx),
    ]);

    return { volume, spend, competition, suppliers };
  }

  /** Award counts and values per supplier for one buyer. Facts, ordered. */
  static async topSuppliersForBuyer(buyerId, { sinceMonths = null, limit = 5 } = {}, trx = db) {
    const rows = await withinWindow(
      trx('awards as a')
        .join('tenders as t', 't.id', 'a.tender_id')
        .join('parties as p', 'p.id', 'a.supplier_id')
        .where('t.buyer_id', buyerId),
      sinceMonths
    )
      .groupBy('a.supplier_id', 'p.name')
      .select(
        'a.supplier_id',
        'p.name',
        trx.raw('count(*)::int as award_count'),
        trx.raw('sum(a.amount)::numeric as total_value'),
        trx.raw('max(t.published_at) as last_won_at')
      )
      .orderByRaw('count(*) desc, sum(a.amount) desc')
      .limit(limit);

    return rows.map((r) => ({
      supplierId: r.supplier_id,
      name: r.name,
      awardCount: int(r.award_count),
      totalValue: num(r.total_value),
      lastWonAt: r.last_won_at,
    }));
  }

  // ------------------------------------------------ whole-population rebuild

  /**
   * Every supplier's aggregates in three queries instead of four per supplier.
   *
   * The per-supplier methods above are the right shape for the API, which asks
   * about one competitor at a time. They are the wrong shape for the nightly
   * rebuild: 1,220 suppliers x 4 round trips to a remote Postgres measured at
   * roughly 25 minutes, and it grows linearly with a corpus that is currently
   * 2.5% seeded. These aggregates are a `GROUP BY supplier_id` — the loop was
   * never doing anything the database could not do in one pass.
   *
   * `rivalsFor` is deliberately NOT batched: it is a self-join over shared
   * lots, its all-suppliers form is a cross product, and nothing persists it —
   * it is assembled live for the one profile being read.
   */
  static async computeAllSuppliers({ sinceMonths = null } = {}, trx = db) {
    const [activity, wins, categories] = await Promise.all([
      withinWindow(
        trx('public_tender_bids as b')
          .join('tenders as t', 't.id', 'b.tender_id')
          .whereNotNull('b.supplier_id'),
        sinceMonths
      )
        .groupBy('b.supplier_id')
        .select(
          'b.supplier_id',
          trx.raw('count(*)::int as lots_bid'),
          trx.raw(
            `round(avg((b.budget_price - b.final_offer_price) / nullif(b.budget_price, 0) * 100)
               filter (where b.status = 'accepted' and b.budget_price > 0)::numeric, 2)
             as avg_discount_pct`
          )
        ),

      withinWindow(
        trx('awards as a')
          .join('tenders as t', 't.id', 'a.tender_id')
          .whereNotNull('a.supplier_id'),
        sinceMonths
      )
        .groupBy('a.supplier_id')
        .select('a.supplier_id', trx.raw('count(*)::int as lots_won')),

      withinWindow(
        trx('public_tender_bids as b')
          .with('lot_category', lotCategoryCte)
          .join('tenders as t', 't.id', 'b.tender_id')
          .leftJoin('lot_category as l', function joinLot() {
            this.on('l.tender_id', '=', 'b.tender_id').andOn('l.lot_number', '=', 'b.lot_number');
          })
          .whereNotNull('b.supplier_id')
          .whereRaw('coalesce(l.cpv_code, t.cpv_code) is not null'),
        sinceMonths
      )
        .groupByRaw('b.supplier_id, coalesce(l.cpv_code, t.cpv_code)')
        .select(
          'b.supplier_id',
          trx.raw('coalesce(l.cpv_code, t.cpv_code) as cpv_code'),
          trx.raw('count(*)::int as lots_bid')
        )
        .orderByRaw('b.supplier_id, count(*) desc'),
    ]);

    const wonBy = new Map(wins.map((w) => [w.supplier_id, int(w.lots_won)]));
    const catsBy = new Map();
    for (const row of categories) {
      const list = catsBy.get(row.supplier_id) ?? [];
      // Ordered by count desc in SQL, so the cap keeps the most-bid categories.
      if (list.length < 50) list.push(row.cpv_code);
      catsBy.set(row.supplier_id, list);
    }

    return activity.map((a) => ({
      supplierId: a.supplier_id,
      lotsBid: int(a.lots_bid),
      lotsWon: wonBy.get(a.supplier_id) ?? 0,
      avgDiscountPct: num(a.avg_discount_pct),
      categories: catsBy.get(a.supplier_id) ?? [],
    }));
  }

  /** Every buyer's aggregates, same reasoning as computeAllSuppliers. */
  static async computeAllBuyers({ sinceMonths = null, topSuppliers = 5 } = {}, trx = db) {
    const [volume, spend, top] = await Promise.all([
      withinWindow(trx('tenders as t').whereNotNull('t.buyer_id'), sinceMonths)
        .groupBy('t.buyer_id')
        .select('t.buyer_id', trx.raw('count(*)::int as tender_count')),

      withinWindow(
        trx('awards as a').join('tenders as t', 't.id', 'a.tender_id').whereNotNull('t.buyer_id'),
        sinceMonths
      )
        .groupBy('t.buyer_id')
        .select('t.buyer_id', trx.raw('sum(a.amount)::numeric as total_spend')),

      // Ranked inside the database: a window function returns only the rows
      // that will actually be stored, rather than every (buyer, supplier) pair
      // for Node to sort and discard.
      trx
        .with('ranked', (qb) => {
          withinWindow(
            qb
              .select('t.buyer_id', 'a.supplier_id')
              .count('* as award_count')
              .sum({ total_value: 'a.amount' })
              .from('awards as a')
              .join('tenders as t', 't.id', 'a.tender_id')
              .whereNotNull('t.buyer_id')
              .whereNotNull('a.supplier_id'),
            sinceMonths
          ).groupBy('t.buyer_id', 'a.supplier_id');
        })
        .select('buyer_id', 'supplier_id')
        .from((qb) =>
          qb
            .select(
              'buyer_id',
              'supplier_id',
              trx.raw(
                'row_number() over (partition by buyer_id order by award_count desc, total_value desc) as rn'
              )
            )
            .from('ranked')
            .as('r')
        )
        .where('rn', '<=', topSuppliers)
        .orderBy(['buyer_id', 'rn']),
    ]);

    const spendBy = new Map(spend.map((r) => [r.buyer_id, num(r.total_spend)]));
    const topBy = new Map();
    for (const row of top) {
      const list = topBy.get(row.buyer_id) ?? [];
      list.push(row.supplier_id);
      topBy.set(row.buyer_id, list);
    }

    return volume.map((v) => ({
      buyerId: v.buyer_id,
      tenderCount: int(v.tender_count),
      totalSpend: spendBy.get(v.buyer_id) ?? null,
      favoredSupplierIds: topBy.get(v.buyer_id) ?? [],
    }));
  }

  /**
   * Bulk upsert, chunked.
   *
   * Postgres caps a statement at 65,535 bind parameters; at four columns a
   * chunk of 500 is two orders of magnitude clear of that and still turns
   * 1,220 statements into three.
   */
  static async bulkUpsert(table, key, rows, trx = db, chunk = 500) {
    if (!rows.length) return 0;
    const columns = Object.keys(rows[0]).filter((c) => c !== key && c !== 'id');
    let written = 0;

    for (let i = 0; i < rows.length; i += chunk) {
      const slice = rows.slice(i, i + chunk).map((r) => ({ id: createId(), ...r }));
      await trx(table).insert(slice).onConflict(key).merge(columns);
      written += slice.length;
    }
    return written;
  }

  // ------------------------------------------------------- the recompute set

  /** Every supplier that has bid at least once — the supplier recompute set. */
  static async suppliersWithActivity(trx = db) {
    const rows = await trx('public_tender_bids')
      .whereNotNull('supplier_id')
      .distinct('supplier_id');
    return rows.map((r) => r.supplier_id);
  }

  /** Every buyer that has published at least one tender. */
  static async buyersWithActivity(trx = db) {
    const rows = await trx('tenders').whereNotNull('buyer_id').distinct('buyer_id');
    return rows.map((r) => r.buyer_id);
  }

  // ------------------------------------------------------------ materialised

  static async findSupplier(supplierId, trx = db) {
    return trx(SUPPLIER_TABLE).where({ supplier_id: supplierId }).first();
  }

  static async findBuyer(buyerId, trx = db) {
    return trx(BUYER_TABLE).where({ buyer_id: buyerId }).first();
  }

  /**
   * Both upserts go through the table's unique key on the party id, so the
   * database arbitrates the concurrent-write race rather than application
   * logic — the same choice `source_payloads` and `tenders.source_id` make.
   */
  static async upsertSupplier({ supplierId, winRate, categories, avgDiscountPct }, trx = db) {
    const row = {
      supplier_id: supplierId,
      win_rate: winRate,
      categories,
      avg_discount_pct: avgDiscountPct,
    };
    const [saved] = await trx(SUPPLIER_TABLE)
      .insert({ id: createId(), ...row })
      .onConflict('supplier_id')
      .merge(row)
      .returning('id');
    return saved?.id ?? null;
  }

  static async upsertBuyer({ buyerId, totalSpend, tenderCount, favoredSupplierIds }, trx = db) {
    const row = {
      buyer_id: buyerId,
      total_spend: totalSpend,
      tender_count: tenderCount,
      // The column name is the schema's. What goes in it is simply the
      // suppliers that won this buyer's work most often — see computeBuyer.
      favored_supplier_ids: favoredSupplierIds,
    };
    const [saved] = await trx(BUYER_TABLE)
      .insert({ id: createId(), ...row })
      .onConflict('buyer_id')
      .merge(row)
      .returning('id');
    return saved?.id ?? null;
  }
}
