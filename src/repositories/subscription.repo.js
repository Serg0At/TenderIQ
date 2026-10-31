import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';

const TABLE = 'subscriptions';

const UNIQUE_VIOLATION = '23505';

/**
 * "The period covering now", the one definition of it. Half-open like the
 * exclusion constraint's range, so at the instant one period ends and the next
 * begins exactly one of them covers it. Read against the database clock, never
 * a status: a lapsed period stops granting its plan with nothing to flip it.
 */
const COVERS_NOW_SQL = 'tstzrange(s.period_start, s.period_end) @> now()';

const columns = ['s.id', 's.kind', 'p.name as plan', 's.period_start', 's.period_end'];

/**
 * An organization's subscriptions: dated periods, one row each (ADR 0005).
 *
 * Scoped by organization like every private repository, except
 * `creatorHasTrial`, which asks the one cross-tenant question a trial needs (has
 * this person had one in any organization?) and answers only yes or no.
 */
export default class SubscriptionRepository {
  /**
   * The non-voided period covering now, with its plan's name, or null.
   * subscriptions_no_overlap_excl is what makes `first()` the answer rather
   * than one of several.
   */
  static async current(organizationId, trx = db) {
    const row = await trx(`${TABLE} as s`)
      .join('plans as p', 'p.id', 's.plan_id')
      .where('s.organization_id', organizationId)
      .whereNull('s.voided_at')
      .whereRaw(COVERS_NOW_SQL)
      .first(columns);
    return row ?? null;
  }

  /** The earliest non-voided period that has not started yet, or null. */
  static async next(organizationId, trx = db) {
    const row = await trx(`${TABLE} as s`)
      .join('plans as p', 'p.id', 's.plan_id')
      .where('s.organization_id', organizationId)
      .whereNull('s.voided_at')
      .whereRaw('s.period_start > now()')
      .orderBy([{ column: 's.period_start' }, { column: 's.id' }])
      .first(columns);
    return row ?? null;
  }

  /** Whether the organization has ever had a subscription, voided ones included. */
  static async everHad(organizationId, trx = db) {
    const row = await trx(TABLE).where({ organization_id: organizationId }).first('id');
    return Boolean(row);
  }

  /**
   * Whether this person has had a trial, in any organization, voided or not —
   * a voided trial still counts as used, or voiding one would hand its creator
   * another.
   */
  static async creatorHasTrial(userId, trx = db) {
    const row = await trx(TABLE).where({ kind: 'trial', trial_creator_id: userId }).first('id');
    return Boolean(row);
  }

  /**
   * The non-voided promo or paid period that has not ended — current or still
   * to come — or null. A scheduled one counts: a second code redeemed beside it
   * could only overlap it.
   */
  static async unendedGrant(organizationId, trx = db) {
    const row = await trx(`${TABLE} as s`)
      .join('plans as p', 'p.id', 's.plan_id')
      .where('s.organization_id', organizationId)
      .whereIn('s.kind', ['promo', 'paid'])
      .whereNull('s.voided_at')
      .whereRaw('s.period_end > now()')
      .orderBy([{ column: 's.period_start' }, { column: 's.id' }])
      .first(columns);
    return row ?? null;
  }

  /** Whether this organization has redeemed this code, voided periods included. */
  static async hasRedeemed(organizationId, promoCodeId, trx = db) {
    const row = await trx(TABLE).where({ organization_id: organizationId, promo_code_id: promoCodeId }).first('id');
    return Boolean(row);
  }

  /**
   * End a current trial now. Returns whether it was ended.
   *
   * The only edit a period ever takes, and only a trial's: shortening it is how
   * an owner who redeems a code takes the promo at once. Never lengthens one
   * (`period_end > now()`), and never empties one, which the period CHECK would
   * refuse anyway.
   */
  static async endTrialNow(id, organizationId, trx = db) {
    const updated = await trx(TABLE)
      .where({ id, organization_id: organizationId, kind: 'trial' })
      .whereNull('voided_at')
      .whereRaw('period_start < now() AND period_end > now()')
      .update({ period_end: trx.raw('now()') });
    return updated === 1;
  }

  /**
   * Insert a promo period of `months` calendar months, redeemed with
   * `promoCodeId`, and return its id — or null when this organization has
   * already redeemed that code (`subscriptions_promo_code_org_uq`). As with
   * `createTrial`, a caller handed null must end the transaction.
   *
   * It starts now, or where period `after` ends. That end is read here in SQL,
   * never passed in: a JavaScript Date holds milliseconds and the column
   * microseconds, so a start handed back from a fetched row would begin just
   * before the trial ends and overlap it.
   *
   * Months are counted on the Yerevan calendar whatever the session's time
   * zone, so a database in GMT and one in Asia/Yerevan grant the same period.
   */
  static async createPromo({ organizationId, planId, promoCodeId, months, after = null }, trx = db) {
    const start = after
      ? trx.raw('(SELECT period_end FROM subscriptions WHERE id = ? AND organization_id = ?)', [after, organizationId])
      : trx.raw('now()');
    const id = createId();
    try {
      await trx(TABLE).insert({
        id,
        organization_id: organizationId,
        plan_id: planId,
        kind: 'promo',
        period_start: start,
        period_end: trx.raw(
          `((?::timestamptz AT TIME ZONE 'Asia/Yerevan') + make_interval(months => ?)) AT TIME ZONE 'Asia/Yerevan'`,
          [start, months]
        ),
        promo_code_id: promoCodeId,
      });
      return id;
    } catch (error) {
      if (error.code === UNIQUE_VIOLATION && error.constraint === 'subscriptions_promo_code_org_uq') return null;
      throw error;
    }
  }

  /**
   * Insert a trial on `planId`, starting now and lasting `days`, and return its
   * id — or null when its creator already has a trial elsewhere.
   *
   * `subscriptions_trial_creator_uq` arbitrates that, never a lookup first: two
   * organizations of one creator each lock only their own row, so both
   * re-checks can pass. The violation aborts the transaction, so a caller
   * handed null must end it. Both ends come from the database clock, the one
   * `current` reads against.
   */
  static async createTrial({ organizationId, planId, creatorId, days }, trx = db) {
    const id = createId();
    try {
      await trx(TABLE).insert({
        id,
        organization_id: organizationId,
        plan_id: planId,
        kind: 'trial',
        period_start: trx.raw('now()'),
        period_end: trx.raw('now() + make_interval(days => ?)', [days]),
        trial_creator_id: creatorId,
      });
      return id;
    } catch (error) {
      if (error.code === UNIQUE_VIOLATION && error.constraint === 'subscriptions_trial_creator_uq') return null;
      throw error;
    }
  }
}
