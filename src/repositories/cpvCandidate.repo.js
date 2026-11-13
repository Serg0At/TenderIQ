import db from '../libs/knex.js';
import { cpvLevel } from '../libs/cpv.js';

/** Stated-code lots read per search: the neighbourhood the codes are counted over. */
const NEIGHBOUR_LOTS = 100;
/** Codes kept from those lots, most similar first. */
const LOT_CODES = 20;
/** Classifier entries kept by name similarity. */
const CLASSIFIER_CODES = 15;
/** The part of a lot name compared; the trigram index is on exactly this. */
const NAME_HEAD = 100;

/**
 * Similarity of `a` and `b` (SQL expressions; `b` a bound text): the better of
 * the whole strings' and their equal-length heads'.
 */
const similaritySql = (a, b) =>
  `greatest(similarity(${a}, ${b}), similarity(left(${a}, length(${b})), left(${b}, length(${a}))))`;

/**
 * Candidate codes for a lot whose source states none (cpv-inference ticket 02,
 * ADR 0006): the closed set an inferred code is chosen from.
 *
 * Two places a code can come from:
 *   - the codes Armenian buyers STATED on lots named like this one — never an
 *     inferred code, so a guess is never the evidence for another guess;
 *   - classifier entries whose own name is like the lot's.
 * Both read only codes the classifier holds and has not withdrawn: a withdrawn
 * code is never a candidate, though a lot that already carries one keeps its
 * name. Public data; nothing here is tenant-scoped.
 *
 * Similarity is pg_trgm's, over a name's first NAME_HEAD characters: a lot
 * names its item first and an e-auction lot then runs on into specification
 * (1 in 10 is over 900 characters), which costs a second a search and lets a
 * word deep in a spec match. Two names score the better of their trigram
 * similarity and that of their equal-length heads — each cut to the shorter
 * one's length — so a short paper name («Բանան») finds the long lot that
 * starts with it («Բանան թարմ, պտղաբանական I խմբի…»), and a short classifier
 * name the long lot name it opens. Measured on 2026-11-13 (ticket 02): equal
 * agreement, more lots answered than whole-name similarity alone.
 *
 * The prefilter is pg_trgm's operators at their default thresholds (`%` 0.3,
 * `<%` 0.6). On lots it must stay index-backed, through
 * `tender_lots_name_trgm_idx` — on `left(name, 100)`, the exact expression
 * used here, or the planner cannot use it — so it asks only "the lot is like
 * the name" and "the name opens the lot": "the lot opens the name" puts the
 * indexed column on the side GIN cannot serve, and a seq scan of every lot
 * name took half a second. The classifier asks it anyway: 11,000 short names
 * scan in a fifth of a second, and that is how a long lot name finds the
 * classifier name it starts with.
 */
export default class CpvCandidateRepository {
  /**
   * At most LOT_CODES + CLASSIFIER_CODES candidates, one per code, most
   * similar first:
   *   { code, name, level, uses, lotSimilarity, nameSimilarity }
   * `uses` counts the tenders whose similar lots carried the code (0 for a code
   * from the classifier's names alone); `lotSimilarity` is the most similar such
   * lot's (null likewise); `nameSimilarity` is the classifier name's.
   *
   * A candidate is never drawn from the lot itself (`lotId`). The backtest also
   * passes `excludeTenderIds` — the held-out lot's own tender and its
   * re-announcements — so a lot is not graded on its siblings' copy of its code.
   */
  static async candidatesFor({ lotId = null, name, excludeTenderIds = [] }, trx = db) {
    const text = String(name ?? '').trim().slice(0, NAME_HEAD);
    if (!text) return [];
    const head = `left(l.name, ${NAME_HEAD})`;

    const [fromLots, fromNames] = await Promise.all([
      trx
        .with('near', (qb) =>
          qb
            .from('tender_lots as l')
            .join('cpv_classifier as c', 'c.code', 'l.cpv_code')
            .whereNotNull('l.cpv_code')
            .whereNull('c.withdrawn_in')
            .whereRaw(`(${head} % :q or :q <% ${head})`, { q: text })
            .whereRaw('l.id is distinct from ?', [lotId])
            .whereRaw('l.tender_id <> all(?::text[])', [excludeTenderIds])
            .select('l.cpv_code as code', 'l.tender_id', trx.raw(`${similaritySql(head, ':q')} as sim`, { q: text }))
            .orderBy('sim', 'desc')
            .limit(NEIGHBOUR_LOTS)
        )
        .from('near as n')
        .join('cpv_classifier as c', 'c.code', 'n.code')
        .groupBy('n.code', 'c.name')
        .select(
          'n.code',
          'c.name',
          trx.raw('max(n.sim)::float8 as lot_similarity'),
          trx.raw('count(distinct n.tender_id)::int as uses'),
          trx.raw(`${similaritySql('c.name', ':q')}::float8 as name_similarity`, { q: text })
        )
        .orderByRaw('lot_similarity desc, uses desc, n.code')
        .limit(LOT_CODES),
      trx('cpv_classifier')
        .whereNull('withdrawn_in')
        .whereRaw('(name % :q or name <% :q)', { q: text })
        .select('code', 'name', trx.raw(`${similaritySql('name', ':q')}::float8 as name_similarity`, { q: text }))
        .orderByRaw('name_similarity desc, code')
        .limit(CLASSIFIER_CODES),
    ]);

    const byCode = new Map();
    for (const r of fromLots) {
      byCode.set(r.code, {
        code: r.code,
        name: r.name,
        level: cpvLevel(r.code),
        uses: r.uses,
        lotSimilarity: r.lot_similarity,
        nameSimilarity: r.name_similarity,
      });
    }
    for (const r of fromNames) {
      if (byCode.has(r.code)) continue;
      byCode.set(r.code, {
        code: r.code,
        name: r.name,
        level: cpvLevel(r.code),
        uses: 0,
        lotSimilarity: null,
        nameSimilarity: r.name_similarity,
      });
    }
    return [...byCode.values()];
  }

  /**
   * Stated-code lots to hold out, for `npm run cpv:backtest`: one per distinct
   * (tender, name, code), since a tender often repeats a name item by item and
   * a sample of copies measures one lot many times. Only codes the classifier
   * holds, so agreement is always possible. A seeded hash orders the draw, so
   * a run is repeatable.
   *
   * Each row carries `exclude_tender_ids`: its own tender and every tender of
   * the same reference code (a re-announcement copies its lots word for word).
   */
  static async labelledLots({ channels, kindLabel, limit, seed = 'cpv' }, trx = db) {
    return trx
      .with('items', (qb) =>
        qb
          .from('tender_lots as l')
          .join('tenders as t', 't.id', 'l.tender_id')
          .join('cpv_classifier as c', 'c.code', 'l.cpv_code')
          .whereNotNull('l.cpv_code')
          .whereNull('c.withdrawn_in')
          .whereRaw("btrim(coalesce(l.name, '')) <> ''")
          .whereIn('t.submission_channel', channels)
          .where('t.goods_works_services', kindLabel)
          .select(
            trx.raw(`distinct on (l.tender_id, lower(btrim(l.name)), l.cpv_code)
              l.id, l.tender_id, l.name, l.cpv_code, t.reference_code, t.submission_channel`)
          )
          .orderBy([
            { column: 'l.tender_id' },
            { column: trx.raw('lower(btrim(l.name))') },
            { column: 'l.cpv_code' },
            { column: 'l.id' },
          ])
      )
      .from('items as i')
      .select(
        'i.id',
        'i.tender_id',
        'i.name',
        'i.cpv_code',
        'i.submission_channel',
        trx.raw(
          `array(select t2.id from tenders t2
                  where t2.id = i.tender_id or t2.reference_code = i.reference_code) as exclude_tender_ids`
        )
      )
      .orderByRaw('md5(i.id || ?)', [seed])
      .limit(limit);
  }

  /** Lots by id, with what the backtest needs to hold them out; for a hand-labelled file. */
  static async lotsByIds(ids, trx = db) {
    if (!ids.length) return [];
    return trx('tender_lots as l')
      .join('tenders as t', 't.id', 'l.tender_id')
      .whereIn('l.id', ids)
      .select(
        'l.id',
        'l.tender_id',
        'l.name',
        't.submission_channel',
        trx.raw(
          `array(select t2.id from tenders t2
                  where t2.id = l.tender_id or t2.reference_code = t.reference_code) as exclude_tender_ids`
        )
      );
  }

  /**
   * Paper lots with no stated code, for an owner to label by hand: current
   * runs, not cancelled, one per distinct name, those naming `word` in the lot
   * or its tender first, newest first. Each comes with the tender's subject
   * (title and, for paper, the contract subject).
   */
  static async paperLotsToLabel({ word, limit, excludeIds = [] }, trx = db) {
    const pattern = `%${word}%`;
    return trx
      .with('items', (qb) =>
        qb
          .from('tender_lots as l')
          .join('tenders as t', 't.id', 'l.tender_id')
          .where('t.submission_channel', 'paper')
          .where('t.is_latest', true)
          .whereNot('t.status', 'cancelled')
          .whereNull('l.cpv_code')
          .whereRaw("btrim(coalesce(l.name, '')) <> ''")
          .whereRaw('l.id <> all(?::text[])', [excludeIds])
          .select(
            trx.raw(
              `distinct on (lower(btrim(l.name))) l.id, l.name, t.title, t.description, t.published_at,
                (l.name ilike ? or t.title ilike ? or coalesce(t.description, '') ilike ?) as has_word`,
              [pattern, pattern, pattern]
            )
          )
          .orderBy([{ column: trx.raw('lower(btrim(l.name))') }, { column: 't.published_at', order: 'desc' }])
      )
      .from('items')
      .select('*')
      .orderByRaw('has_word desc, published_at desc nulls last, id')
      .limit(limit);
  }
}
