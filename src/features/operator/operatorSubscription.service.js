import subscriptions from '../../repositories/subscription.repo.js';
import organizations from '../../repositories/organization.repo.js';
import { ApiError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

/** A period as the operator console shows it. */
const present = (row) => ({
  id: row.id,
  kind: row.kind,
  plan: row.plan,
  periodStart: row.period_start,
  periodEnd: row.period_end,
  coversNow: row.covers_now,
  promoCode: row.promo_code_id ? { id: row.promo_code_id, code: row.promo_code } : null,
  voidedAt: row.voided_at,
  voidedBy: row.voided_by ? { userId: row.voided_by, displayName: row.voided_by_name ?? null } : null,
  createdAt: row.created_at,
});

/**
 * One organization's subscriptions, as the operator answers "why is this
 * company on Pro" and ends a grant made in error.
 */
export default class OperatorSubscriptionService {
  static async listForOrganization(organizationId) {
    const organization = await organizations.findById(organizationId);
    if (!organization) throw ApiError.notFound('Organization');
    return (await subscriptions.listForOrganization(organizationId)).map(present);
  }

  /**
   * Void a period. Repeating it is a success that keeps the first void.
   *
   * Nothing else changes: a voided trial still counts as the creator's trial and
   * a voided promo as the organization's use of its code, and the code's
   * redemption count stays. The organization's sessions carry the old plan
   * until their next refresh, which reads whatever else covers now, or `free`.
   */
  static async voidPeriod(operatorId, id) {
    const outcome = await subscriptions.voidPeriod(id, operatorId);
    if (!outcome) throw ApiError.notFound('Subscription');

    const row = await subscriptions.findById(id);
    if (outcome === 'voided') {
      logger.info(`[operator] subscription ${id} (${row.kind}, ${row.plan}) of ${row.organization_id} voided by user ${operatorId}`);
    }
    return present(row);
  }
}
