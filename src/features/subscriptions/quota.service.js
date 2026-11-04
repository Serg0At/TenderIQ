import { withTransaction } from '../../libs/knex.js';
import { checklistQuotaFor } from '../../libs/permissions.js';
import subscriptions from '../../repositories/subscription.repo.js';
import organizations from '../../repositories/organization.repo.js';
import generations from '../../repositories/checklistGeneration.repo.js';
import { ApiError } from '../../utils/errors.js';

/**
 * The checklist quota: how many generations an organization may request in one
 * Yerevan calendar month of its current subscription (CONTEXT.md, Quota).
 *
 * The limit is read from the subscription covering now, never from the token:
 * a token's plan can be one access-token lifetime stale, and spend must not be.
 */
export default class QuotaService {
  /** `{ used, limit, resetsAt }` for the organization, as of now. */
  static async read(organizationId, trx) {
    const period = await subscriptions.current(organizationId, trx);
    const { used, resetsAt } = await generations.usage(organizationId, period?.id ?? null, trx);
    return { used, limit: checklistQuotaFor(period), resetsAt };
  }

  /**
   * Spend one generation, or refuse with `QUOTA_EXCEEDED` and
   * `{ used, limit, resetsAt }`.
   *
   * Under the organization row lock, so two requests for the last unit are
   * serialized: there is no constraint that can arbitrate a count, so the lock
   * is the arbiter, the choke point the trial and redemption use too. The
   * caller queues the job only after this returns, i.e. after the commit.
   */
  static async spend({ organizationId, trackedTenderId, userId }) {
    await withTransaction(async (trx) => {
      await organizations.lockForUpdate(organizationId, trx);
      const quota = await QuotaService.read(organizationId, trx);
      if (quota.used >= quota.limit) {
        throw new ApiError('QUOTA_EXCEEDED', {
          message:
            quota.limit === 0
              ? "This organization's plan includes no checklist generations."
              : `This organization has used all ${quota.limit} checklist generations for this month.`,
          details: { used: quota.used, limit: quota.limit, resetsAt: quota.resetsAt },
        });
      }
      await generations.record({ organizationId, trackedTenderId, userId }, trx);
    });
  }
}
