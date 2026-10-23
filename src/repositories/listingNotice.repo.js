import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';
import { codeKeySql } from './tender.repo.js';

const TABLE = 'listing_notices';

/**
 * Every notice an invitation listing has shown (ticket 31): its code as the
 * title names it, and when it was published. The question it answers is
 * "was an invitation of this code ever published", which the domain tables
 * cannot: a notice whose job failed, or whose file nobody could read, leaves
 * no tender, and was still published. Public data, so no organization scope.
 */
export default class ListingNoticeRepository {
  /**
   * Record a notice the listing showed. An upsert on `(source, external_id)`,
   * so a re-listed notice is one row, and a title edited to name a code fills
   * the blank — a later title without one does not forget it.
   */
  static async record({ source, externalId, listing, procedureCode = null, publishedAt }, trx = db) {
    await trx(TABLE)
      .insert({
        id: createId(),
        source,
        external_id: String(externalId),
        listing,
        procedure_code: procedureCode,
        published_at: publishedAt,
      })
      .onConflict(['source', 'external_id'])
      .merge({
        procedure_code: trx.raw('coalesce(excluded.procedure_code, ??)', [`${TABLE}.procedure_code`]),
      });
  }

  /**
   * What the listing says about one result's procedure — `wasPublic`'s facts
   * (services/resolution.service.js):
   *
   *   codeSeen        a notice of the code `key` (a normalized code) was ever
   *                   listed — by its title's code, or, for a title naming
   *                   none, by the code of the tender its link created
   *   uncodedNearby   a notice published in `[from, to)` whose code nobody
   *                   knows: no code in its title, and no coded tender behind
   *                   it. It could be the procedure the result is about.
   */
  static async publicityFacts({ source, key, from, to }, trx = db) {
    const notices = () =>
      trx(`${TABLE} as n`)
        .leftJoin('tender_sources as s', function joinLink() {
          this.on('s.source', '=', 'n.source').andOn('s.external_id', '=', 'n.external_id');
        })
        .leftJoin('tenders as t', 't.id', 's.tender_id')
        .where('n.source', source);

    const seen = key
      ? await notices()
        .where((q) =>
          q.whereRaw(`${codeKeySql('n.procedure_code')} = ?`, [key])
            .orWhereRaw(`${codeKeySql('t.reference_code')} = ?`, [key])
        )
        .first('n.id')
      : null;
    const uncoded = from && to
      ? await notices()
        .where('n.published_at', '>=', from)
        .andWhere('n.published_at', '<', to)
        .whereNull('n.procedure_code')
        .whereNull('t.reference_code')
        .first('n.id')
      : null;
    return { codeSeen: Boolean(seen), uncodedNearby: Boolean(uncoded) };
  }
}
