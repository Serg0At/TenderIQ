import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';

const TABLE = 'tender_sources';

/**
 * Every source a tender came from (ADR 0004): one row per `(source, external_id)`
 * link, with what that source last said about the tender's status.
 */
export default class TenderSourceRepository {
  /**
   * Record that a source showed this tender, now.
   *
   * An upsert on the dedupe anchor, so re-seeing a link refreshes it and a
   * concurrent insert that loses the race lands as an update rather than a
   * 23505 — the database arbitrates, as it does for `source_payloads`.
   *
   * `tender_id` and `first_seen_at` are never overwritten. Moving a link to
   * another tender is a resolution decision, and an upsert is the wrong place
   * for one to happen by accident.
   *
   * `seenAt` is when the source was fetched, not when this runs: a replay
   * from storage re-reads an old page and must not claim the source answered
   * today. So `last_seen_at` only ever moves forward, and an observation
   * older than the stored one updates nothing else either — an old page's
   * status must not overwrite a newer one.
   */
  static async upsert({ tenderId, source, externalId, url = null, role, observedStatus = null, seenAt = new Date() }, trx = db) {
    const newer = (column) =>
      trx.raw('case when excluded.last_seen_at >= ?? then excluded.?? else ?? end', [
        `${TABLE}.last_seen_at`, column, `${TABLE}.${column}`,
      ]);
    await trx(TABLE)
      .insert({
        id: createId(),
        tender_id: tenderId,
        source,
        external_id: String(externalId),
        url,
        role,
        observed_status: observedStatus,
        first_seen_at: seenAt,
        last_seen_at: seenAt,
      })
      .onConflict(['source', 'external_id'])
      .merge({
        url: newer('url'),
        role: newer('role'),
        observed_status: newer('observed_status'),
        last_seen_at: trx.raw('greatest(??, excluded.last_seen_at)', [`${TABLE}.last_seen_at`]),
      });
  }

  /**
   * The source answered and nothing it says has changed — a 304, or a page
   * whose hash is already stored. Only `last_seen_at` moves. A link not yet
   * written (the tender's first fetch is still being normalized) is a no-op.
   */
  static async touch({ source, externalId, seenAt = new Date() }, trx = db) {
    return trx(TABLE)
      .where({ source, external_id: String(externalId) })
      .where('last_seen_at', '<', seenAt)
      .update({ last_seen_at: seenAt });
  }

  /** One tender's links, oldest first: the creating source leads. */
  static async listForTender(tenderId, trx = db) {
    return trx(TABLE)
      .where({ tender_id: tenderId })
      .orderBy([{ column: 'first_seen_at' }, { column: 'id' }])
      .select('source', 'external_id', 'url', 'role', 'observed_status', 'first_seen_at', 'last_seen_at');
  }
}
