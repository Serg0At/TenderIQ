import db from '../libs/knex.js';

const TABLE = 'cpv_classifier';

/** Rows per insert: 6 columns each, well inside Postgres's 65,535 bind parameters. */
const CHUNK = 1000;

/**
 * The CPV classifier (cpv-inference ticket 01, ADR 0006). Public reference
 * data, not tenant-scoped. Written only by `cpv:refresh`; never touches a
 * tender or a lot.
 */
export default class CpvClassifierRepository {
  /**
   * Every row, withdrawn ones included: what a refresh compares a file with.
   * Versions come back as `YYYY-MM-DD` text — node-postgres would otherwise
   * turn a `date` into a local-midnight Date, one day off west of UTC.
   */
  static async listAll(trx = db) {
    return trx(TABLE).select(
      'code',
      'name',
      'unit',
      'eauction_only',
      trx.raw(`to_char(version, 'YYYY-MM-DD') as version`),
      trx.raw(`to_char(withdrawn_in, 'YYYY-MM-DD') as withdrawn_in`)
    );
  }

  /**
   * Names of the given codes, withdrawn ones included — a withdrawn code a
   * tender still carries keeps its name. A code the classifier lacks is
   * absent from the map.
   */
  static async namesFor(codes, trx = db) {
    const list = [...new Set(codes.filter(Boolean))];
    if (!list.length) return new Map();
    const rows = await trx(TABLE).whereIn('code', list).select('code', 'name');
    return new Map(rows.map((r) => [r.code, r.name]));
  }

  /**
   * Write one version of the classifier, in one transaction: every listed
   * code upserted at that version (and un-withdrawn if it had been), every
   * stored code the file no longer lists marked `withdrawn_in` that version.
   * Nothing is deleted — inferred codes reference this table, and a code
   * must keep resolving to its name after the ministry drops it.
   */
  static async replace(entries, version, trx = db) {
    const run = async (t) => {
      const rows = entries.map((e) => ({
        code: e.code,
        name: e.name,
        unit: e.unit ?? null,
        version,
        eauction_only: Boolean(e.eauctionOnly),
        withdrawn_in: null,
      }));
      for (let i = 0; i < rows.length; i += CHUNK) {
        await t(TABLE)
          .insert(rows.slice(i, i + CHUNK))
          .onConflict('code')
          .merge(['name', 'unit', 'version', 'eauction_only', 'withdrawn_in']);
      }
      const withdrawn = await t(TABLE)
        .whereNull('withdrawn_in')
        .whereRaw('code <> all(?::text[])', [rows.map((r) => r.code)])
        .update({ withdrawn_in: version });
      return { written: rows.length, withdrawn };
    };
    return trx === db ? db.transaction(run) : run(trx);
  }
}
