import db from '../libs/knex.js';

const TABLE = 'public_tender_bids';

/**
 * The public bid ledger — every company that bid on a finished tender, what it
 * offered, and whether the buyer accepted or rejected it.
 *
 * This is the table the reference specification did not expect to be
 * obtainable. It is scraped from the `Գնառաջարկներ` panel that appears on a
 * settled tender's page, and it is the sole public source of competitor
 * pricing: `awards` records only the winner, so without this there is no
 * answer to "what did the others offer".
 *
 * Distinct from `bids`, which is a customer's own private bid package.
 *
 * Two rules govern every query here, both learned by comparing stored numbers
 * against physically plausible ones:
 *
 *   1. **Money statistics exclude rejected bids.** The source publishes
 *      rejected submissions with their prices, and some are absurd — a
 *      6,666,600,000,000 AMD offer against a 75,000 budget. Averaging those in
 *      put the mean bid at 317,831,314,144 AMD instead of 2,957,029.
 *   2. **Participation counts include them.** Being rejected is still showing
 *      up, and still losing. A bidder count that quietly dropped rejects would
 *      understate competition, which is the number a supplier is pricing
 *      against.
 *
 * So: `count(*)` over everything, `avg`/`percentile` over accepted only. Every
 * aggregate below states which of the two it is.
 */

/**
 * One row per (tender, lot) from `tender_lots`.
 *
 * A `tender_lots` row is one ITEM, not one lot — the invitation's Ծածկագիր cell
 * reads "45000000/2", code then item sequence, so a lot may carry several. In
 * today's corpus every lot happens to have exactly one, but joining a bid or an
 * award straight to `tender_lots` would multiply the row the day that stops
 * being true, silently inflating every count and re-weighting every percentile
 * by item count. Collapsing first makes the join safe by construction rather
 * than by luck.
 *
 * `distinct on` takes the lowest `item_sequence`, so the category is the lot's
 * first-listed code and the choice is deterministic across runs.
 */
const lotCategoryCte = (qb) =>
  qb.distinctOn('tender_id', 'lot_number')
    .select('tender_id', 'lot_number', 'cpv_code', 'name')
    .from('tender_lots')
    .orderBy([
      { column: 'tender_id' },
      { column: 'lot_number' },
      { column: 'item_sequence' },
    ]);

export default class PublicBidRepository {
  /**
   * Every bid on one tender, with the bidder named and the winner marked.
   *
   * Ordered by lot then rank so the caller can group by lot without sorting,
   * and so rank 1 is always the first row of its group.
   *
   * The winner is taken from `awards` rather than from `rank = 1`: the source
   * ranks rejected submissions too, and awarding on rank alone named a company
   * the buyer had thrown out in 21% of cases. `awards` is rebuilt from this
   * same ledger as the lowest-ranked ACCEPTED bid, so it is the arbitrated
   * answer and this only has to read it.
   */
  static async ledgerForTender(tenderId, trx = db) {
    return trx(`${TABLE} as b`)
      .leftJoin('parties as p', 'p.id', 'b.supplier_id')
      // Matching on source as well keeps a future second writer's award from
      // marking a winner in this source's ledger.
      .leftJoin('awards as a', function joinAward() {
        this.on('a.tender_id', '=', 'b.tender_id')
          .andOn('a.lot_number', '=', 'b.lot_number')
          .andOn('a.source', '=', 'b.source');
      })
      .where('b.tender_id', tenderId)
      .select(
        'b.lot_number',
        'b.supplier_id',
        'p.name as supplier_name',
        'p.region as supplier_region',
        'b.rank',
        'b.budget_price',
        'b.initial_offer_price',
        'b.final_offer_price',
        'b.vat_pct',
        'b.status',
        'b.currency',
        'b.application_url',
        // coalesce, because a lot with no award at all leaves a.supplier_id
        // NULL and the comparison would yield NULL rather than false.
        trx.raw('coalesce(a.supplier_id = b.supplier_id, false) as is_winner')
      )
      .orderBy([
        { column: 'b.lot_number' },
        // NULLS LAST: an unranked bid is not a leading bid.
        { column: 'b.rank', order: 'asc', nulls: 'last' },
        { column: 'b.final_offer_price', order: 'asc' },
      ]);
  }

  /**
   * The award for each lot of one tender, with the lot's category and the
   * winning supplier named.
   *
   * Read separately from the ledger rather than folded into it because the two
   * answer different questions and a lot can have one without the other: a lot
   * whose every bid was rejected has a ledger and no award, and an award
   * written by some future non-ledger source would have an award and no ledger.
   * Joining them into a single query would silently drop whichever side is
   * missing.
   */
  /**
   * Where one supplier appears in one tender's ledger.
   *
   * The join that answers "did WE win this" — `bids` stores a tenant's own
   * price, this stores who actually won, and `organizations.supplier_party_id`
   * is the bridge between them.
   *
   * Returns every lot the party bid on, because a multi-lot procurement can be
   * won and lost at the same time and the caller has to decide which lot it
   * meant. `is_winner` comes from `awards`, not from `rank = 1`: the source
   * ranks REJECTED submissions too, and awarding on rank alone once recorded
   * 21% of awards to companies the buyer had thrown out.
   */
  static async supplierEntriesForTender(tenderId, supplierPartyId, trx = db) {
    if (!supplierPartyId) return [];
    return trx(`${TABLE} as b`)
      .leftJoin('awards as a', function joinAward() {
        this.on('a.tender_id', '=', 'b.tender_id')
          .andOn('a.lot_number', '=', 'b.lot_number')
          .andOn('a.source', '=', 'b.source');
      })
      .where({ 'b.tender_id': tenderId, 'b.supplier_id': supplierPartyId })
      .select(
        'b.lot_number',
        'b.rank',
        'b.status',
        'b.final_offer_price',
        'b.budget_price',
        'b.currency',
        'a.supplier_id as award_supplier_id',
        'a.amount as award_amount',
        trx.raw('coalesce(a.supplier_id = b.supplier_id, false) as is_winner')
      )
      .orderBy('b.lot_number');
  }

  static async awardsForTender(tenderId, trx = db) {
    return trx('awards as a')
      .with('lot_category', lotCategoryCte)
      .leftJoin('parties as p', 'p.id', 'a.supplier_id')
      .leftJoin('lot_category as l', function joinLot() {
        this.on('l.tender_id', '=', 'a.tender_id').andOn('l.lot_number', '=', 'a.lot_number');
      })
      .where('a.tender_id', tenderId)
      .select(
        'a.lot_number',
        'a.supplier_id',
        'p.name as supplier_name',
        'p.region as supplier_region',
        'a.amount',
        'a.estimated_value',
        'a.currency',
        'a.awarded_at',
        'a.status',
        'l.cpv_code',
        'l.name as lot_name'
      )
      .orderBy('a.lot_number');
  }

  /**
   * Lots of one tender that appear in the ledger but nowhere else.
   *
   * `tender_lots` is populated from the invitation archive, which is only
   * fetched for some tenders — 264 of 724 at the last audit — so a tender can
   * have a full bid ledger and no lot rows at all. The competitor-price view
   * must still list those lots, or the feature would appear empty for most of
   * the corpus. This supplies the lot's category and name where they exist and
   * nulls where they do not, keyed off the ledger rather than off `tender_lots`.
   */
  static async lotsForTender(tenderId, trx = db) {
    return trx(`${TABLE} as b`)
      .with('lot_category', lotCategoryCte)
      .leftJoin('lot_category as l', function joinLot() {
        this.on('l.tender_id', '=', 'b.tender_id').andOn('l.lot_number', '=', 'b.lot_number');
      })
      .where('b.tender_id', tenderId)
      .groupBy('b.lot_number', 'l.cpv_code', 'l.name')
      .select(
        'b.lot_number',
        'l.cpv_code',
        'l.name as lot_name',
        // Participation: every bid, rejected included.
        trx.raw('count(*)::int as bidder_count'),
        trx.raw(`count(*) filter (where b.status = 'accepted')::int as accepted_count`),
        trx.raw(`count(*) filter (where b.status = 'rejected')::int as rejected_count`),
        // The buyer's published budget for the lot. Every bid on a lot carries
        // the same figure, so max() is just a way to pick it up through the
        // GROUP BY rather than an aggregate with meaning.
        trx.raw('max(b.budget_price)::numeric as budget_price'),
        // Money: accepted only.
        trx.raw(
          `min(b.final_offer_price) filter (where b.status = 'accepted')::numeric as lowest_accepted`
        ),
        trx.raw(
          `max(b.final_offer_price) filter (where b.status = 'accepted')::numeric as highest_accepted`
        )
      )
      .orderBy('b.lot_number');
  }

  /**
   * How many bidders a lot in this category has historically drawn.
   *
   * The "estimated competition" figure, and the one piece of intelligence that
   * works on a tender that has NOT settled — which is the only kind a supplier
   * can still act on. It answers "roughly how many companies will I be bidding
   * against" from the same ledger the retrospective view reads, so it needs no
   * award, no CPV on the tender being priced, and no AI.
   *
   * Counts are participation, so rejected bids are included by rule 2 above.
   *
   * @param {object} opts
   * @param {string} opts.cpvCode      category to match; null = every category
   * @param {boolean} opts.exact       true = this code only; false = its family
   * @param {string|null} opts.buyerId restrict to one buying agency
   * @param {number} opts.sinceMonths  recency window
   */
  static async expectedCompetition(
    { cpvCode = null, exact = true, buyerId = null, sinceMonths = 24 } = {},
    trx = db
  ) {
    // Family match walks up the CPV hierarchy by stripping trailing zeros, the
    // same rule benchmark.repo.js uses — 33141211 -> '33141211%',
    // 33140000 -> '3314%'. Kept identical on purpose: two different notions of
    // "related category" in one intelligence layer is a correctness trap.
    const prefix = cpvCode && !exact ? String(cpvCode).replace(/0+$/, '') : null;

    const row = await trx
      .with('lot_category', lotCategoryCte)
      .with('lot_bidders', (qb) => {
        qb.select('b.tender_id', 'b.lot_number')
          .count('* as n')
          .from(`${TABLE} as b`)
          .join('tenders as t', 't.id', 'b.tender_id')
          .leftJoin('lot_category as l', function joinLot() {
            this.on('l.tender_id', '=', 'b.tender_id').andOn('l.lot_number', '=', 'b.lot_number');
          })
          .whereRaw(`t.published_at >= now() - (? || ' months')::interval`, [
            String(Number(sinceMonths)),
          ])
          .groupBy('b.tender_id', 'b.lot_number');

        if (buyerId) qb.andWhere('t.buyer_id', buyerId);
        if (cpvCode && exact) qb.andWhereRaw('coalesce(l.cpv_code, t.cpv_code) = ?', [cpvCode]);
        if (cpvCode && !exact) {
          qb.andWhereRaw('coalesce(l.cpv_code, t.cpv_code) like ?', [`${prefix}%`]);
        }
      })
      .select(
        trx.raw('count(*)::int as sample_lots'),
        trx.raw('round(avg(n), 1)::numeric as avg_bidders'),
        trx.raw('percentile_cont(0.5) within group (order by n)::numeric as median_bidders'),
        trx.raw('max(n)::int as max_bidders'),
        trx.raw('count(*) filter (where n = 1)::int as sole_bidder_lots')
      )
      .from('lot_bidders')
      .first();

    return {
      sampleLots: Number(row?.sample_lots ?? 0),
      avgBidders: row?.avg_bidders == null ? null : Number(row.avg_bidders),
      medianBidders: row?.median_bidders == null ? null : Number(row.median_bidders),
      maxBidders: row?.max_bidders == null ? null : Number(row.max_bidders),
      soleBidderLots: Number(row?.sole_bidder_lots ?? 0),
    };
  }
}
