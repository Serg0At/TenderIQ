import db from '../libs/knex.js';

/**
 * Inferred CPV codes on lots (cpv-inference ticket 04, ADR 0006): which lots
 * of a tender are still to be coded, and the outcome of coding them. Public
 * data; nothing here is tenant-scoped.
 *
 * Writes only the `inferred_cpv_*` columns. Never `cpv_code`, never a tender
 * column — so coding a lot can never move `version` or raise an amendment —
 * and only on a lot that is still a candidate: no stated code and never tried.
 * That guard is in the UPDATE itself, so a lot that gained a stated code
 * between the read and the write is left alone rather than tripping
 * `tender_lots_inferred_cpv_stated_chk`, and a retried job never codes a lot
 * twice.
 *
 * Lots are written as delete-and-insert by `tender.repo.js#applyInvitationFacts`
 * and get new ids every time, so an id read before a rewrite matches nothing
 * after it: the rewrite's own job codes the new rows.
 */

/** A lot whose source states no code, never tried, with a name to read. */
const candidate = (qb) =>
  qb.whereNull('l.cpv_code').whereNull('l.inferred_cpv_at').whereRaw("btrim(coalesce(l.name, '')) <> ''");

export default class InferredCpvRepository {
  /**
   * The tender's lots still to be coded, with what a method reads beside the
   * lot name: the tender's title and (paper) contract subject.
   */
  static async lotsToCode(tenderId, trx = db) {
    return trx('tender_lots as l')
      .join('tenders as t', 't.id', 'l.tender_id')
      .where('l.tender_id', tenderId)
      .modify(candidate)
      .orderBy(['l.lot_number', 'l.item_sequence', 'l.id'])
      .select('l.id', 'l.name', 'l.lot_number', 't.title', 't.description');
  }

  /**
   * What the re-match after coding decides on (ticket 05): the tender's state,
   * the fields its purchase kind is read from, and how many of its lots hold
   * an inferred code now — whichever attempt wrote them. Null for a tender
   * that no longer exists.
   */
  static async rematchFacts(tenderId, trx = db) {
    const row = await trx('tenders as t')
      .where('t.id', tenderId)
      .first(
        't.id',
        't.status',
        't.deadline_at',
        't.version',
        't.goods_works_services',
        't.reference_code',
        trx.raw(
          '(select count(*)::int from tender_lots l where l.tender_id = t.id and l.inferred_cpv_code is not null) as inferred_lots'
        )
      );
    return row ?? null;
  }

  /**
   * The classifier version an inference is chosen from: the newest file's
   * date among codes still listed, as `YYYY-MM-DD` (null when the classifier
   * was never loaded).
   */
  static async classifierVersion(trx = db) {
    const row = await trx('cpv_classifier')
      .whereNull('withdrawn_in')
      .first(trx.raw(`to_char(max(version), 'YYYY-MM-DD') as version`));
    return row?.version ?? null;
  }

  /**
   * Record one outcome on the given lots: a code (`code`) or the reason none
   * was written (`unclassified`), with its provenance either way. Only lots
   * that are still candidates are touched; returns how many were.
   */
  static async record(ids, { code = null, unclassified = null, method, model = null, classifierVersion, at = new Date() }, trx = db) {
    if (!ids.length) return 0;
    return trx('tender_lots as l')
      .whereIn('l.id', ids)
      .modify(candidate)
      .update({
        inferred_cpv_code: code,
        inferred_cpv_unclassified: code ? null : unclassified,
        inferred_cpv_method: method,
        inferred_cpv_model: method === 'model' ? model : null,
        inferred_cpv_classifier_version: classifierVersion,
        inferred_cpv_at: at,
      });
  }
}
