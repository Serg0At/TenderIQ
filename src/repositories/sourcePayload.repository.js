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

  static async findLatestByRef(source, ref) {
    return await db(TABLE).where({ source, ref }).orderBy('fetched_at', 'desc').first();
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
