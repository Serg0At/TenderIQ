import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';

const TABLE = 'checklist_generations';

/**
 * The start of the current calendar month and of the next one, on the Yerevan
 * calendar whatever the session's time zone, as `timestamptz`. The same
 * fixed-zone arithmetic the promo months use, so a database in GMT and one in
 * Asia/Yerevan agree on when a quota resets.
 */
const MONTH_START_SQL = `(date_trunc('month', now() AT TIME ZONE 'Asia/Yerevan') AT TIME ZONE 'Asia/Yerevan')`;
const NEXT_MONTH_START_SQL = `((date_trunc('month', now() AT TIME ZONE 'Asia/Yerevan') + interval '1 month') AT TIME ZONE 'Asia/Yerevan')`;

/**
 * Accepted checklist generations — what an organization's quota counts.
 * Private tenant data, scoped by organization in every method.
 */
export default class ChecklistGenerationRepository {
  /**
   * How many generations this organization has made in the current window, and
   * when the window resets.
   *
   * The window opens at the later of the first of this Yerevan month and the
   * start of `subscriptionId` (the period covering now, or null), so a new
   * subscription starts its quota afresh. Its start is read here in SQL, never
   * passed in: a JavaScript Date drops the microseconds the column holds.
   */
  static async usage(organizationId, subscriptionId, trx = db) {
    const since = subscriptionId
      ? trx.raw(
          `greatest(${MONTH_START_SQL}, (SELECT period_start FROM subscriptions WHERE id = ? AND organization_id = ?))`,
          [subscriptionId, organizationId]
        )
      : trx.raw(MONTH_START_SQL);
    const { rows } = await trx.raw(
      `SELECT
         (SELECT count(*)::int FROM ${TABLE} WHERE organization_id = ? AND created_at >= ?) AS used,
         ${NEXT_MONTH_START_SQL} AS resets_at`,
      [organizationId, since]
    );
    return { used: rows[0].used, resetsAt: rows[0].resets_at };
  }

  /** Record one accepted generation, and return its id. */
  static async record({ organizationId, trackedTenderId, userId }, trx = db) {
    const id = createId();
    await trx(TABLE).insert({
      id,
      organization_id: organizationId,
      tracked_tender_id: trackedTenderId,
      requested_by: userId ?? null,
    });
    return id;
  }
}
