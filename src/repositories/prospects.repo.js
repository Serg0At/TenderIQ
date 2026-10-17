/**
 * Public-data prospect queries — SQL only, per the "only repositories touch
 * the database" boundary in CLAUDE.md. No scoring/vertical/tier logic lives
 * here; that belongs in src/services/prospectScoring.service.js, which
 * consumes the raw rows these functions return.
 *
 * Depends on `public_tender_bids` (now part of migrations/create_table.js),
 * which is populated by the ARMEPS completed-tender bids-table parser — see
 * detail.parser.js `parseBidLedger` and tender.repo.js `replaceLedger`. Rows
 * appear only for tenders whose status has reached `awarded`; until the sweep
 * has ingested some finished tenders, every function here
 * returns an empty array against the live database — that is a correct,
 * honest result, not a bug.
 *
 * `role IN ('supplier', 'both')` everywhere below is deliberate: `parties`
 * widens a name seen as both buyer and supplier to 'both' rather than
 * flip-flopping (see upsertParty in parties.repo.js). A ministry that also
 * shows up as a lot bidder (rare, but the schema allows it) should not be
 * silently dropped from prospect candidates, and — just as important — a
 * plain 'buyer' row must never appear here. If this filter is ever loosened,
 * re-read the TERMINOLOGY note at the top of this project's brief first:
 * `role = 'buyer'` is a government agency, never a prospect.
 */

import db from '../libs/knex.js';

const SUPPLIER_ROLES = ['supplier', 'both'];

/**
 * One row per candidate supplier, aggregated from their public bid history.
 * Sortable only on columns SQL can honestly rank by (volume, value, recency)
 * — the weighted ICP score itself is a service-layer concern.
 *
 * @param {{ sinceMonths?: number, minBids?: number, orderBy?: 'bid_count'|'total_final_value'|'last_tender_published_at' }} [opts]
 */
export const listProspectCandidates = async (
  { sinceMonths = 12, minBids = 1, orderBy = 'bid_count' } = {},
  trx = db
) => {
  const since = trx.raw(`now() - interval '${Number(sinceMonths)} months'`);
  const orderColumn = ['bid_count', 'total_final_value', 'last_tender_published_at'].includes(orderBy)
    ? orderBy
    : 'bid_count';

  return trx('public_tender_bids as b')
    .join('parties as p', 'p.id', 'b.supplier_id')
    .join('tenders as t', 't.id', 'b.tender_id')
    .whereIn('p.role', SUPPLIER_ROLES)
    .whereNotNull('b.supplier_id')
    .groupBy('p.id', 'p.name', 'p.tax_id', 'p.region')
    .select(
      'p.id as supplier_id',
      'p.name as supplier_name',
      'p.tax_id as tax_id',
      'p.region as region',
      trx.raw('count(*)::int as bid_count'),
      trx.raw('count(distinct b.tender_id)::int as tender_count'),
      trx.raw(`count(*) filter (where b.rank = 1 and b.status <> 'rejected')::int as win_count`),
      trx.raw(`count(*) filter (where b.rank <> 1 or b.status = 'rejected')::int as loss_count`),
      /**
       * Money statistics count ACCEPTED bids only.
       *
       * A rejected bid was thrown out by the buyer, so it is not evidence of
       * what anything sells for — and it is where the garbage lives: one
       * bidder submitted 6,666,600,000,000 AMD against a 75,000 budget and was
       * duly rejected. Including rejects put the average bid at 317 billion
       * AMD instead of 3 million, a 107,000x error that fed straight into
       * value-density scoring.
       *
       * Without VAT, so a VAT payer and a non-payer are on one scale; the
       * gross figure includes 20% that is not the supplier's revenue.
       *
       * The win/loss counts above deliberately do NOT filter: being rejected
       * is still participation, and still a loss.
       */
      trx.raw(`sum(b.final_offer_net) filter (where b.status = 'accepted')::numeric as total_final_value`),
      trx.raw(`percentile_cont(0.5) within group (order by b.final_offer_net) filter (where b.status = 'accepted')::numeric as median_final_value`),
      trx.raw(`min(b.final_offer_net) filter (where b.status = 'accepted')::numeric as min_final_value`),
      trx.raw(`max(b.final_offer_net) filter (where b.status = 'accepted')::numeric as max_final_value`),
      trx.raw('min(t.published_at) as first_tender_published_at'),
      trx.raw('max(t.published_at) as last_tender_published_at'),
      // Titles + goods/works/services labels for the last N tenders this
      // supplier bid on — the service infers vertical and top categories
      // from this text. Capped at 50 to keep the row bounded; a supplier
      // needing more than 50 samples to classify is not this stage's problem.
      trx.raw(
        `(array_agg(distinct t.title || '::' || coalesce(t.goods_works_services, '')) filter (where t.title is not null))[1:50] as sampled_tenders`
      )
    )
    .where('t.published_at', '>=', since)
    .havingRaw('count(*) >= ?', [minBids])
    .orderBy(orderColumn, 'desc');
};

export const getProspectBidHistory = async (supplierId, { sinceMonths = 24 } = {}, trx = db) => {
  const since = trx.raw(`now() - interval '${Number(sinceMonths)} months'`);

  return trx('public_tender_bids as b')
    .join('tenders as t', 't.id', 'b.tender_id')
    .join('parties as buyer', 'buyer.id', 't.buyer_id')
    .where('b.supplier_id', supplierId)
    .where('t.published_at', '>=', since)
    .select(
      't.id as tender_id',
      't.source_id as tender_source_id',
      't.title as tender_title',
      't.goods_works_services',
      't.reference_code',
      'buyer.name as buyer_name',
      'b.lot_number',
      'b.rank',
      'b.status',
      'b.budget_price',
      'b.final_offer_net',
      't.published_at',
      't.deadline_at'
    )
    .orderBy('t.published_at', 'desc');
};

/**
 * Proof-sheet source data: every lot this supplier bid on and did NOT win,
 * paired with the winning bid on that same (tender, lot) — "their missed
 * tenders + rival's winning prices" from Sales Strategy.md, as an exact
 * query rather than a description.
 *
 * A lost lot with no rank=1 counterpart (e.g. the whole lot was cancelled,
 * or the winner's supplier_id failed to resolve) is still returned, with
 * `rival_*` columns null — the caller must render that as "result unknown",
 * never omit the row or invent a rival.
 */
export const getProofSheetData = async (supplierId, { sinceMonths = 24 } = {}, trx = db) => {
  const since = trx.raw(`now() - interval '${Number(sinceMonths)} months'`);

  return trx('public_tender_bids as lost')
    .join('tenders as t', 't.id', 'lost.tender_id')
    .join('parties as buyer', 'buyer.id', 't.buyer_id')
    .leftJoin('public_tender_bids as won', function joinWinner() {
      // The rival to compare against is the winning bid — which means the
      // best-ranked ACCEPTED bid, not whatever ranked 1. A rejected rank-1
      // bidder never won the lot, and comparing a real price against their
      // discarded number produces a meaningless "% above winner".
      this.on('won.tender_id', '=', 'lost.tender_id')
        .andOn('won.lot_number', '=', 'lost.lot_number')
        .andOn('won.status', '=', trx.raw(`'accepted'`))
        .andOn('won.rank', '=', trx.raw('1'));
    })
    .leftJoin('parties as rival', 'rival.id', 'won.supplier_id')
    .where('lost.supplier_id', supplierId)
    .where((qb) => qb.where('lost.rank', '<>', 1).orWhere('lost.status', 'rejected'))
    .where('t.published_at', '>=', since)
    .select(
      't.id as tender_id',
      't.title as tender_title',
      't.reference_code',
      'buyer.name as buyer_name',
      'lost.lot_number',
      'lost.final_offer_net as our_final_price',
      'won.final_offer_net as rival_final_price',
      'rival.name as rival_supplier_name',
      't.published_at',
      't.deadline_at',
      trx.raw(
        `case when lost.final_offer_net is not null and won.final_offer_net is not null and won.final_offer_net <> 0
              then round(((lost.final_offer_net - won.final_offer_net) / won.final_offer_net * 100)::numeric, 1)
              else null end as pct_above_winner`
      )
    )
    .orderBy('t.published_at', 'desc');
};

export default { listProspectCandidates, getProspectBidHistory, getProofSheetData };
