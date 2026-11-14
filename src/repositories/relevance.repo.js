import db from '../libs/knex.js';
import { tenderCodesSql } from './tender.repo.js';
import supplierIdentities from './supplierIdentity.repo.js';

/** One row per (tender, lot): the lot's first item code, as profile.repo.js reads a lot's category. */
const lotCategoryCte = (qb) =>
  qb.distinctOn('tender_id', 'lot_number')
    .select('tender_id', 'lot_number', 'cpv_code')
    .from('tender_lots')
    .orderBy([{ column: 'tender_id' }, { column: 'lot_number' }, { column: 'item_sequence' }]);

/**
 * The evidence relevance ranks on, for one organization.
 *
 * Every private read is scoped on `organization_id` here, not by the caller:
 * saved searches and fields are this tenant's own claims, and nothing read for
 * one organization's ranking may describe another's. The ledger is the
 * exception that proves it — it is public record, keyed on the party the
 * organization claimed, and identical whoever asks.
 */
export default class RelevanceRepository {
  /**
   * Every lot these parties bid on in the public ledger, rejected bids
   * included, with whether they won it.
   *
   * A win is an `awards` row naming the party — never `rank = 1`, which the
   * source assigns to rejected submissions too. The category is the lot's
   * code, falling back to the tender's headline code. `at` is when the bid was
   * made: the auction, else the deadline, else publication.
   *
   * `before` replays the ledger as of a past moment, for the backtest: only
   * bids whose auction had already happened. A lot's award is published days
   * after its auction, so a replay counts a win from its auction date — a few
   * days early, and on the generous side.
   *
   * Returns a Map of party id → items.
   */
  static async ledgerFor(partyIds, { before = null } = {}, trx = db) {
    const byParty = new Map(partyIds.map((id) => [id, []]));
    if (!partyIds.length) return byParty;

    const query = trx('public_tender_bids as b')
      .with('lot_category', lotCategoryCte)
      .join('tenders as t', 't.id', 'b.tender_id')
      .leftJoin('lot_category as l', function joinLot() {
        this.on('l.tender_id', '=', 'b.tender_id').andOn('l.lot_number', '=', 'b.lot_number');
      })
      .leftJoin('awards as a', function awardOfLot() {
        this.on('a.tender_id', '=', 'b.tender_id')
          .andOn('a.lot_number', '=', 'b.lot_number')
          .andOn('a.source', '=', 'b.source');
      })
      .whereIn('b.supplier_id', partyIds)
      .select(
        'b.supplier_id',
        'b.tender_id',
        'b.lot_number',
        trx.raw('coalesce(l.cpv_code, t.cpv_code) as cpv_code'),
        't.buyer_id',
        trx.raw('coalesce(t.auction_at, t.deadline_at, t.published_at) as at'),
        trx.raw('coalesce(a.supplier_id = b.supplier_id, false) as won')
      );

    if (before) query.whereRaw('coalesce(t.auction_at, t.deadline_at, t.published_at) < ?', [before]);

    for (const row of await query) {
      byParty.get(row.supplier_id).push({
        tenderId: row.tender_id,
        lot: row.lot_number,
        cpvCode: row.cpv_code,
        buyerId: row.buyer_id,
        at: row.at,
        won: row.won,
      });
    }
    return byParty;
  }

  /**
   * Who bid on these tenders, from the public ledger: a Map of party id →
   * the tender ids it bid on. For the backtest, these are the real bids a
   * replayed ranking is graded against.
   */
  static async biddersOn(tenderIds, trx = db) {
    const byParty = new Map();
    if (!tenderIds.length) return byParty;
    const rows = await trx('public_tender_bids')
      .whereIn('tender_id', tenderIds)
      .whereNotNull('supplier_id')
      .distinct('supplier_id', 'tender_id');
    for (const row of rows) {
      if (!byParty.has(row.supplier_id)) byParty.set(row.supplier_id, []);
      byParty.get(row.supplier_id).push(row.tender_id);
    }
    return byParty;
  }

  /** The median moment a bid in the ledger was made — the backtest's default cut-off. */
  static async medianLedgerDate(trx = db) {
    const row = await trx('public_tender_bids as b')
      .join('tenders as t', 't.id', 'b.tender_id')
      .first(
        trx.raw(
          'percentile_disc(0.5) within group (order by coalesce(t.auction_at, t.deadline_at, t.published_at)) as at'
        )
      );
    return row?.at ? new Date(row.at) : null;
  }

  /**
   * Title and lot names of public tenders, for word overlap: a Map of id → text.
   *
   * Each item name is cut to its first 300 characters. The item's name comes
   * first and the specification paragraph after it, and it is the specification
   * that makes lot text average ~3,000 characters a tender; the words that say
   * what is being bought are at the front.
   */
  static async textFor(tenderIds, trx = db) {
    if (!tenderIds.length) return new Map();
    const rows = await trx('tenders as t')
      .whereIn('t.id', tenderIds)
      .select(
        't.id',
        trx.raw(
          `concat_ws(' ', t.title, (select string_agg(left(l.name, 300), ' ') from tender_lots l where l.tender_id = t.id)) as text`
        )
      );
    return new Map(rows.map((row) => [row.id, row.text]));
  }

  /**
   * Everything this organization is tracking, with every CPV code each tender
   * carries (`tenderCodesSql`, inferred lot codes included when `inferredKinds`
   * lets them count) and when the team last acted on it.
   *
   * Private tenant data: scoped on `tt.organization_id` here, so one tenant's
   * pursuits can never inform another's ranking.
   */
  static async pipelineFor(organizationId, { inferredKinds = [] } = {}, trx = db) {
    const rows = await trx('tracked_tenders as tt')
      .join('tenders as t', 't.id', 'tt.tender_id')
      .where('tt.organization_id', organizationId)
      .select(
        'tt.id',
        'tt.tender_id',
        'tt.status',
        'tt.go_no_go',
        trx.raw('coalesce(tt.updated_at, tt.created_at) as at'),
        trx.raw(`array_remove(array(select distinct c from unnest(${tenderCodesSql('t', { inferredKinds })}) as c), null) as codes`)
      );

    return rows.map((row) => ({
      trackedTenderId: row.id,
      tenderId: row.tender_id,
      status: row.status,
      goNoGo: row.go_no_go,
      at: row.at,
      codes: row.codes ?? [],
    }));
  }

  /**
   * The organization's signal bundle, loaded once per request.
   *
   * Shaped for `rankTenders`: camelCase, no Knex rows past this point.
   * `inferredKinds` is the inferred-CPV gate, for the pipeline's codes.
   */
  static async signalsFor(organizationId, { inferredKinds = [] } = {}, trx = db) {
    const [organization, searches, pipeline] = await Promise.all([
      trx('organizations').where({ id: organizationId }).first('type'),
      trx('saved_searches')
        .where({ organization_id: organizationId })
        .orderBy([{ column: 'created_at' }, { column: 'id' }])
        .select('id', 'name', 'cpv_codes', 'keywords', 'min_value', 'max_value'),
      RelevanceRepository.pipelineFor(organizationId, { inferredKinds }, trx),
    ]);

    // The ledger needs the claimed identities first, so it is the second round trip.
    // No identity, no ledger: the ranking runs on what else it has, and the
    // basis names the missing claim. Every claimed party's lots are one ledger
    // (ticket 32): they are one company's bids.
    const partyIds = await supplierIdentities.partyIdsFor(organizationId, trx);
    const byParty = await RelevanceRepository.ledgerFor(partyIds, {}, trx);
    const ledger = partyIds.flatMap((id) => byParty.get(id) ?? []);

    return {
      fields: organization?.type ?? [],
      ledger: { partyIds, items: ledger },
      pipeline,
      savedSearches: searches.map((s) => ({
        id: s.id,
        name: s.name,
        cpvCodes: s.cpv_codes ?? [],
        keywords: s.keywords ?? [],
        minValue: s.min_value,
        maxValue: s.max_value,
      })),
    };
  }
}
