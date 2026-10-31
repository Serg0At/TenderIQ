import subscriptions from '../../repositories/subscription.repo.js';
import organizations from '../../repositories/organization.repo.js';
import { ApiError } from '../../utils/errors.js';

/** One period as a client sees it. */
const presentPeriod = (row) =>
  row
    ? { id: row.id, kind: row.kind, plan: row.plan, periodStart: row.period_start, periodEnd: row.period_end }
    : null;

/**
 * An organization's subscriptions (ADR 0005). Nothing writes one through the
 * API yet; the trial and promo codes are the next tickets.
 */
export default class SubscriptionService {
  /**
   * Which plan the organization is on and until when, what follows it, and
   * whether a trial could be started.
   *
   * A trial is available exactly when the organization has never had a
   * subscription and the person who created it has never had a trial anywhere.
   * Both count voided rows: a voided grant was still a grant.
   */
  static async current(organizationId) {
    const organization = await organizations.findById(organizationId);
    if (!organization) throw ApiError.notFound('Organization');

    const [current, next, everHad, creatorHadTrial] = await Promise.all([
      subscriptions.current(organizationId),
      subscriptions.next(organizationId),
      subscriptions.everHad(organizationId),
      subscriptions.creatorHasTrial(organization.created_by),
    ]);

    return {
      current: presentPeriod(current),
      next: presentPeriod(next),
      trialAvailable: !everHad && !creatorHadTrial,
    };
  }
}
