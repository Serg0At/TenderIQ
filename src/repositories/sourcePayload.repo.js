import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';

const TABLE = 'source_payloads';

const UNIQUE_VIOLATION = '23505';

export default class SourcePayloadRepository {
  static async existsWithHash(source, ref, hash) {
    const row = await db(TABLE).select('id').where({ source, ref, hash }).first();
    return Boolean(row);
  }

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

  /** The newest stored payload of every ref under a prefix (`detail:`), one row each. */
  static async latestByPrefix(prefix) {
    return db(TABLE)
      .distinctOn('source', 'ref')
      .where('ref', 'like', `${prefix}%`)
      .orderBy([{ column: 'source' }, { column: 'ref' }, { column: 'fetched_at', order: 'desc' }])
      .select('source', 'ref', 'storage_key');
  }

  static async findLatestByRef(source, ref) {
    return await db(TABLE).where({ source, ref }).orderBy('fetched_at', 'desc').first();
  }

  /**
   * The listing page stored under one key. A listing notice's row points at
   * the page it was read on, and only the page's own row says which listing
   * that was (`listing:{slug}:p{N}`) — the notices on it share its key.
   */
  static async findListingPage(source, storageKey) {
    return db(TABLE)
      .where({ source, storage_key: storageKey })
      .where('ref', 'like', 'listing:%')
      .orderBy('fetched_at', 'asc')
      .first();
  }

  static async latestFetchedAt(source) {
    const row = await db(TABLE).where({ source }).max('fetched_at as at').first();
    return row?.at ?? null;
  }

  static async countBySource(source) {
    const row = await db(TABLE).where({ source }).count('* as c').first();
    return Number(row.c);
  }
}
