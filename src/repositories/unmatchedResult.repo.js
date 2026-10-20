import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';

const TABLE = 'unmatched_results';

/**
 * Results a source published that could not be attached to exactly one
 * tender (ADR 0004): kept with their reason and counted, never guessed onto a
 * tender and never thrown away. Public data, so no organization scope.
 */
export default class UnmatchedResultRepository {
  /**
   * Record that a result could not be resolved, as of `seenAt`.
   *
   * An upsert on `(source, external_ref)`, so a re-seen result refreshes its
   * row and a concurrent insert that loses the race lands as an update — the
   * database arbitrates, as it does for `tender_sources`.
   *
   * `seenAt` is when the source was fetched, so a replay of an old payload
   * neither moves `last_seen_at` backwards nor overwrites a newer reason.
   * `first_seen_at` and the resolution columns are never touched here:
   * resolving is `markResolved`'s job.
   */
  static async record(
    { source, externalRef, procedureCode = null, reason, candidateTenderIds = [], payloadHash, seenAt = new Date() },
    trx = db
  ) {
    const newer = (column) =>
      trx.raw('case when excluded.last_seen_at >= ?? then excluded.?? else ?? end', [
        `${TABLE}.last_seen_at`, column, `${TABLE}.${column}`,
      ]);
    await trx(TABLE)
      .insert({
        id: createId(),
        source,
        external_ref: String(externalRef),
        procedure_code: procedureCode,
        reason,
        candidate_tender_ids: candidateTenderIds,
        payload_hash: payloadHash,
        first_seen_at: seenAt,
        last_seen_at: seenAt,
      })
      .onConflict(['source', 'external_ref'])
      .merge({
        // A re-read that cannot see the code does not forget it: a replayed
        // paper upload no listing notice travels with knows none.
        procedure_code: trx.raw('coalesce(?, ??)', [newer('procedure_code'), `${TABLE}.procedure_code`]),
        reason: newer('reason'),
        candidate_tender_ids: newer('candidate_tender_ids'),
        payload_hash: newer('payload_hash'),
        last_seen_at: trx.raw('greatest(??, excluded.last_seen_at)', [`${TABLE}.last_seen_at`]),
      });
  }

  /**
   * A result that was unmatched now belongs to `tenderId`. Only an unresolved
   * row moves, so a repeat is a no-op and the first resolution time stands.
   * Returns the number of rows resolved (0 or 1).
   */
  static async markResolved({ source, externalRef, tenderId, resolvedAt = new Date() }, trx = db) {
    return trx(TABLE)
      .where({ source, external_ref: String(externalRef) })
      .whereNull('resolved_at')
      .update({ resolved_tender_id: tenderId, resolved_at: resolvedAt });
  }
}
