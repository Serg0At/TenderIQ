import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';

const TABLE = 'tender_sources';

/**
 * A link's `observed_status` once its run has been replaced: an e-auction
 * amendment is a new tid, and the tids it names are dead runs (ticket 29).
 * Not a label any source prints — Փոփոխված is the page's word for it — but the
 * one state every reader of links asks about: a superseded link is never
 * refreshed, never fetched for documents, and its pages write nothing but
 * itself. It is sticky: a replaced run does not come back, so no later or
 * replayed page overwrites it.
 */
export const SUPERSEDED = 'superseded';

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
  static async upsert({ tenderId, source, externalId, url = null, role, observedStatus = null, pointsTo = null, seenAt = new Date() }, trx = db) {
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
        points_to: pointsTo,
        first_seen_at: seenAt,
        last_seen_at: seenAt,
      })
      .onConflict(['source', 'external_id'])
      .merge({
        url: newer('url'),
        // What a notice points at is its identity's other half and does not
        // move; a blank (a row from before the column) is filled.
        points_to: trx.raw('coalesce(??, excluded.points_to)', [`${TABLE}.points_to`]),
        role: newer('role'),
        // Sticky: a replaced run does not come back, whatever page is read.
        observed_status: trx.raw(
          'case when ?? = ? or excluded.observed_status = ? then ? else ? end',
          [`${TABLE}.observed_status`, SUPERSEDED, SUPERSEDED, SUPERSEDED, newer('observed_status')]
        ),
        last_seen_at: trx.raw('greatest(??, excluded.last_seen_at)', [`${TABLE}.last_seen_at`]),
      });
  }

  /**
   * Record the runs a replacement names as superseded links of its tender
   * (ticket 29), with no request made: a predecessor Tendra never saw is
   * still a link, so anything that later names it resolves here by rule 1.
   *
   * `seenAt` is the replacement's fetch: the moment a source last told us
   * about the run. A link already on this tender is marked superseded; one on
   * another tender is left alone — moving a link is a resolution decision, and
   * resolution refused it (`ambiguous`) or never asked.
   */
  static async markSuperseded({ tenderId, source, runs = [], seenAt = new Date() }, trx = db) {
    if (!runs.length) return;
    await trx(TABLE)
      .insert(
        runs.map((run) => ({
          id: createId(),
          tender_id: tenderId,
          source,
          external_id: String(run.externalId),
          url: run.url ?? null,
          role: 'detail',
          observed_status: SUPERSEDED,
          first_seen_at: seenAt,
          last_seen_at: seenAt,
        }))
      )
      .onConflict(['source', 'external_id'])
      .merge({ observed_status: SUPERSEDED })
      .where(`${TABLE}.tender_id`, tenderId);
  }

  /**
   * Every current detail link of `source` on the tender, other than `keep`,
   * marked superseded: a re-posted paper invitation has joined its run and is
   * the tender's file from now on (ticket 07). Paper names no predecessor, so
   * which runs it replaced is read here, under the caller's row lock — the
   * runs a concurrent re-post committed a moment ago included.
   */
  static async supersedeOthers({ tenderId, source, keep }, trx = db) {
    await trx(TABLE)
      .where({ tender_id: tenderId, source, role: 'detail' })
      .whereNot({ external_id: String(keep) })
      .whereRaw('observed_status is distinct from ?', [SUPERSEDED])
      .update({ observed_status: SUPERSEDED });
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

  /**
   * The discovery links of `source` that point at one link, oldest first: a
   * paper invitation reads its own notices this way on a replay, when no job
   * carries them. Its own, not its tender's — once a re-posted invitation has
   * joined a run (ticket 07), the tender holds the notices of every file it
   * was, and a deadline counted from another file's notice is a wrong one.
   */
  static async listPointingAt({ source, pointsTo }, trx = db) {
    return trx(TABLE)
      .where({ source, points_to: pointsTo })
      .orderBy([{ column: 'first_seen_at' }, { column: 'id' }])
      .select('external_id', 'url', 'role');
  }

  /** One tender's links, oldest first: the creating source leads. */
  static async listForTender(tenderId, trx = db) {
    return trx(TABLE)
      .where({ tender_id: tenderId })
      .orderBy([{ column: 'first_seen_at' }, { column: 'id' }])
      .select('source', 'external_id', 'url', 'role', 'observed_status', 'first_seen_at', 'last_seen_at');
  }
}
