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

/** A period with everything the operator console shows beside it. */
const forOperator = (trx) =>
  trx(`${TABLE} as s`)
    .join('plans as p', 'p.id', 's.plan_id')
    .leftJoin('promo_codes as c', 'c.id', 's.promo_code_id')
    .leftJoin('users as v', 'v.id', 's.voided_by')
    .select(
      ...columns,
      's.organization_id',
      's.promo_code_id',
      'c.code as promo_code',
      's.voided_at',
      's.voided_by',
      'v.display_name as voided_by_name',
      's.created_at',
      trx.raw(`(s.voided_at IS NULL AND ${COVERS_NOW_SQL}) as covers_now`)
    );

/**
 * An organization's subscriptions: dated periods, one row each (ADR 0005).
 *
 * Scoped by organization like every private repository, except
 * `creatorHasTrial`, which asks the one cross-tenant question a trial needs (has
 * this person had one in any organization?) and answers only yes or no,
 * `findById` and `voidPeriod`, which the operator console reaches by a period's
 * id: the operator belongs to no organization, and acts on any one, and
 * `endingOrEnded`, the daily sweep's read across every organization.
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
   * Every period of the organization, voided ones included, as the operator
   * console shows them: oldest first, with the code each came from, who voided
   * it, and whether it is the one covering now.
   *
   * Unpaginated: an organization gets one trial and one period per code, each
   * after the last has ended, so the list stays short.
   */
  static async listForOrganization(organizationId, trx = db) {
    return forOperator(trx)
      .where('s.organization_id', organizationId)
      .orderBy([{ column: 's.period_start' }, { column: 's.id' }]);
  }

  /** One period as `listForOrganization` shows it, by id alone (operator only), or null. */
  static async findById(id, trx = db) {
    const row = await forOperator(trx).where('s.id', id).first();
    return row ?? null;
  }

  /**
   * Every non-voided period ending within `aheadDays`, or ended within the last
   * `backDays`, that no non-voided period of its organization follows — with
   * its plan and organization name, and `ended` saying which side of now its
   * end is on. For the ending announcements, across every organization.
   *
   * A follower starts exactly at the end (a trial cut short by a redeemed code,
   * or a promo queued behind one), so that end is no end at all. Compared here
   * in SQL, never in JavaScript: a Date drops the microseconds both columns
   * hold. Both windows are read against the database clock, the one `current`
   * reads against.
   */
  static async endingOrEnded({ aheadDays, backDays }, trx = db) {
    return trx(`${TABLE} as s`)
      .join('plans as p', 'p.id', 's.plan_id')
      .join('organizations as o', 'o.id', 's.organization_id')
      .whereNull('s.voided_at')
      .whereRaw(
        's.period_end > now() - make_interval(days => ?) AND s.period_end <= now() + make_interval(days => ?)',
        [backDays, aheadDays]
      )
      .whereNotExists(
        trx(`${TABLE} as f`)
          .whereRaw('f.organization_id = s.organization_id')
          .whereRaw('f.period_start = s.period_end')
          .whereRaw('f.id <> s.id')
          .whereNull('f.voided_at')
      )
      .orderBy([{ column: 's.period_end' }, { column: 's.id' }])
      .select(...columns, 's.organization_id', 'o.name as organization_name', trx.raw('s.period_end <= now() as ended'));
  }

  /**
   * Void a period: it grants nothing from now on, and frees its time for the
   * exclusion constraint. Returns `'voided'`, `'already_voided'`, or null when
   * there is no such period.
   *
   * Only an unvoided row is updated, so a repeat keeps the first `voided_at` and
   * `voided_by`, and of two concurrent voids the second waits on the row lock
   * and then matches nothing. The row stays: a voided trial still counts as used
   * and a voided promo as a use of its code, through the indexes that read it.
   */
  static async voidPeriod(id, operatorId, trx = db) {
    const voided = await trx(TABLE)
      .where({ id })
      .whereNull('voided_at')
      .update({ voided_at: trx.raw('now()'), voided_by: operatorId });
    if (voided === 1) return 'voided';
    const row = await trx(TABLE).where({ id }).first('id');
    return row ? 'already_voided' : null;
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
