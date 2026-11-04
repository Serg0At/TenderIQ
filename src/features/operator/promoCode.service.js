import promoCodes from '../../repositories/promoCode.repo.js';
import { ApiError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

/** A code as the operator console shows it. */
const present = (row) => ({
  id: row.id,
  code: row.code,
  plan: row.plan_name,
  percentOff: row.percent_off,
  durationMonths: row.duration_months,
  maxRedemptions: row.max_redemptions,
  redemptionCount: row.redemption_count,
  redeemableUntil: row.redeemable_until,
  disabledAt: row.disabled_at,
  createdBy: row.created_by ? { userId: row.created_by, displayName: row.created_by_name ?? null } : null,
  createdAt: row.created_at,
});

export default class PromoCodeService {
  /**
   * Issue a code.
   *
   * `free` never arrives here — the schema refuses it — so an unknown plan name
   * is the only plan failure left. A code below 100% is stored as asked:
   * redemption refuses it until card payments exist, and the operator may be
   * preparing one for that day.
   */
  static async create(operatorId, { code, plan, percentOff, durationMonths, maxRedemptions, redeemableUntil }) {
    const planId = await promoCodes.planIdByName(plan);
    if (!planId) throw ApiError.validation([{ field: 'plan', message: `There is no plan named "${plan}".` }]);

    const id = await promoCodes.create({
      code,
      planId,
      percentOff,
      durationMonths,
      maxRedemptions,
      redeemableUntil,
      createdBy: operatorId,
    });
    if (!id) throw ApiError.conflict('A promo code with that text already exists.', { code });

    logger.info(`[operator] promo code ${id} (${plan}, ${percentOff}% off) created by user ${operatorId}`);
    return present(await promoCodes.findById(id));
  }

  static async list({ page = {} } = {}) {
    const { rows, cursor, hasMore } = await promoCodes.list({
      limit: page.size ?? 20,
      cursor: page.cursor ?? null,
    });
    return { rows: rows.map(present), cursor, hasMore };
  }

  /**
   * Delete a code nobody has redeemed, or disable one that has been.
   *
   * A redeemed code is kept because the periods it granted point at it, and
   * disabling it leaves them running: closing the launch code must not cut off
   * people who used it in good faith. `outcome` says which happened.
   */
  static async remove(operatorId, id) {
    const result = await promoCodes.deleteOrDisable(id);
    if (!result) throw ApiError.notFound('Promo code');

    logger.info(`[operator] promo code ${id} ${result.outcome} by user ${operatorId}`);
    return { id, outcome: result.outcome, disabledAt: result.disabledAt ?? null };
  }
}
