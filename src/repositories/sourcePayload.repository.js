import { createId } from '@paralleldrive/cuid2';
import db from '../../db/knex.js';

const TABLE = 'source_payloads';

const UNIQUE_VIOLATION = '23505';

export default class SourcePayloadRepository {
  /**
   * The idempotency check, and the pipeline's hottest query: it runs for every
   * notice on every listing page, every five minutes, against the fastest-growing
   * table in the schema. Served by the composite unique index on
   * (source, ref, hash).
   */
  static async existsWithHash(source, ref, hash) {
    const row = await db(TABLE).select('id').where({ source, ref, hash }).first();
    return Boolean(row);
  }

  /**
   * Remember that this exact content was fetched.
   *
   * A concurrent worker inserting the same triple first is a SUCCESS, not a
   * failure — the constraint exists precisely so the database, not application
   * logic, arbitrates that race. Returns false when the row already existed.
   */
  static async record({ source, ref, storageKey, hash, fetchedAt = new Date() }) {
    try {
      await db(TABLE).insert({
        id: createId(),
        source,
        ref,
        storage_key: storageKey,
        hash,
        fetched_at: fetchedAt,
      });
      return true;
    } catch (error) {
      if (error.code === UNIQUE_VIOLATION) return false;
      throw error;
    }
  }

  /** Most recent payload stored for a ref — the current version of that notice. */
  static async findLatestByRef(source, ref) {
    return await db(TABLE).where({ source, ref }).orderBy('fetched_at', 'desc').first();
  }

  /**
   * When this source last produced *new or changed* content.
   *
   * NOT a freshness signal: unchanged content is deliberately not inserted, so a
   * healthy source that simply published nothing for an hour looks stale here.
   * Sweep health is tracked separately (see the scraper worker).
   */
  static async latestFetchedAt(source) {
    const row = await db(TABLE).where({ source }).max('fetched_at as at').first();
    return row?.at ?? null;
  }

  static async countBySource(source) {
    const row = await db(TABLE).where({ source }).count('* as c').first();
    return Number(row.c);
  }
}
