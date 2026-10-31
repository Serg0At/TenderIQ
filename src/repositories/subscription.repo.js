import db from '../libs/knex.js';

const TABLE = 'subscriptions';

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
}
