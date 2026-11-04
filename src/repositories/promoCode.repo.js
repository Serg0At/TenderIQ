import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';

const TABLE = 'promo_codes';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Promo codes, as the operator issues them.
 *
 * Not a private table: a code belongs to no organization, so nothing here is
 * scoped by `organization_id`. Only the operator console reads these rows
 * whole; redemption looks a code up by its text.
 */

/**
 * Whether a code is still open: not disabled, not past its deadline. Read
 * against the database clock.
 */
const OPEN_SQL = `disabled_at IS NULL
  AND (redeemable_until IS NULL OR redeemable_until > now())`;

/**
 * Whether a code can be redeemed right now: open, and not used up. The one
 * definition, shared by the lookup and the conditional UPDATE that counts a
 * redemption.
 */
const REDEEMABLE_SQL = `${OPEN_SQL}
  AND (max_redemptions IS NULL OR redemption_count < max_redemptions)`;

/**
 * The one spelling of a code: trimmed and upper-cased.
 *
 * The CHECK `promo_codes_code_chk` refuses anything else, so a code written by
 * a path that forgot this fails loudly instead of becoming unredeemable.
 */
export const normalizeCode = (code) => String(code).trim().toUpperCase();

const encodeCursor = (row) =>
  Buffer.from(`${new Date(row.created_at).toISOString()}|${row.id}`).toString('base64url');

const decodeCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    return at && id && !Number.isNaN(Date.parse(at)) ? { createdAt: at, id } : null;
  } catch {
    return null;
  }
};

const withPlanAndCreator = (trx) =>
  trx(`${TABLE} as c`)
    .join('plans as p', 'p.id', 'c.plan_id')
    .leftJoin('users as u', 'u.id', 'c.created_by')
    .select('c.*', 'p.name as plan_name', 'u.display_name as created_by_name');

export default class PromoCodeRepository {
  /** A plan's id from its name — the name is the contract (`seed.js`), the id a CUID. */
  static async planIdByName(name, trx = db) {
    const row = await trx('plans').where({ name }).first('id');
    return row?.id ?? null;
  }

  /**
   * Issue a code. Returns its id, or null when the text is already taken.
   *
   * The unique index arbitrates, never a lookup first: two operators creating
   * `LAUNCH100` at once must not both be told it worked.
   */
  static async create(
    { code, planId, percentOff, durationMonths, maxRedemptions = null, redeemableUntil = null, createdBy },
    trx = db
  ) {
    const id = createId();
    try {
      await trx(TABLE).insert({
        id,
        code: normalizeCode(code),
        plan_id: planId,
        percent_off: percentOff,
        duration_months: durationMonths,
        max_redemptions: maxRedemptions,
        redeemable_until: redeemableUntil,
        created_by: createdBy,
      });
      return id;
    } catch (error) {
      if (error.code === UNIQUE_VIOLATION && error.constraint === 'promo_codes_code_uq') return null;
      throw error;
    }
  }

  static async findById(id, trx = db) {
    return withPlanAndCreator(trx).where('c.id', id).first();
  }

  /**
   * A code by the text an owner typed, in any case and with stray spaces, with
   * `open` and `redeemable` computed as `OPEN_SQL` and `REDEEMABLE_SQL` say.
   * Null when no such code.
   */
  static async findByCode(code, trx = db) {
    const row = await trx(TABLE)
      .where({ code: normalizeCode(code) })
      .select(
        'id',
        'plan_id',
        'percent_off',
        'duration_months',
        trx.raw(`(${OPEN_SQL}) as open`),
        trx.raw(`(${REDEEMABLE_SQL}) as redeemable`)
      )
      .first();
    return row ?? null;
  }

  /**
   * Count one redemption, if the code is still redeemable. Returns whether it
   * was counted.
   *
   * The condition is in the UPDATE itself, so the database holds the limit: two
   * organizations redeeming the last use at once both read it as redeemable,
   * the second UPDATE waits on the first's row lock, re-evaluates, and matches
   * nothing. A code disabled in between is refused the same way.
   */
  static async countRedemption(id, trx = db) {
    const updated = await trx(TABLE).where({ id }).whereRaw(REDEEMABLE_SQL).increment('redemption_count', 1);
    return updated === 1;
  }

  /**
   * Every code, newest first, disabled ones included.
   *
   * Descending, so the millisecond truncation of a JS Date is harmless here —
   * it can only exclude the cursor row, never repeat it.
   */
  static async list({ limit = 20, cursor = null } = {}, trx = db) {
    const query = withPlanAndCreator(trx);

    const after = decodeCursor(cursor);
    if (after) query.whereRaw('(c.created_at, c.id) < (?::timestamptz, ?)', [after.createdAt, after.id]);

    const rows = await query
      .orderBy([{ column: 'c.created_at', order: 'desc' }, { column: 'c.id', order: 'desc' }])
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    return {
      rows: page,
      hasMore: rows.length > limit,
      cursor: page.length ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  /**
   * Delete a code nobody has redeemed; disable one that somebody has.
   *
   * Returns `{ outcome: 'deleted' }`, `{ outcome: 'disabled', disabledAt }`, or
   * null when there is no such code.
   *
   * The count is a condition of the DELETE itself, not a read before it, so a
   * redemption committed in between makes the delete match nothing and the code
   * is disabled instead. The foreign key from `subscriptions` is the second
   * line: should a period point at a code whose count says 0, the delete is
   * refused and the code is disabled all the same. The savepoint keeps that
   * refusal from aborting a caller's transaction.
   *
   * Disabling twice keeps the first `disabled_at`.
   */
  static async deleteOrDisable(id, trx = db) {
    let deleted = 0;
    try {
      deleted = await trx.transaction((sp) => sp(TABLE).where({ id, redemption_count: 0 }).del());
    } catch (error) {
      if (error.code !== FOREIGN_KEY_VIOLATION) throw error;
    }
    if (deleted) return { outcome: 'deleted' };

    const [row] = await trx(TABLE)
      .where({ id })
      .update({ disabled_at: trx.raw('coalesce(disabled_at, now())') })
      .returning(['disabled_at']);
    return row ? { outcome: 'disabled', disabledAt: row.disabled_at } : null;
  }
}
