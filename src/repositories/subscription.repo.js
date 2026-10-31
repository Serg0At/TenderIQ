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
