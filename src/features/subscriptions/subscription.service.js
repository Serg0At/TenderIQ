import config from '../../configs/variables.config.js';
import { withTransaction } from '../../libs/knex.js';
import subscriptions from '../../repositories/subscription.repo.js';
import organizations from '../../repositories/organization.repo.js';
import promoCodes from '../../repositories/promoCode.repo.js';
import users from '../../repositories/user.repo.js';
import AuthService from '../auth/auth.service.js';
import { ApiError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

const { BILLING } = config;

/**
 * The plan a trial grants. Fixed: `PLAN_GATED` tells nothing above `pro` apart,
 * so a `business` trial would grant nothing more.
 */
const TRIAL_PLAN = 'pro';

/** One refusal for every reason a trial is not available, so a client has one screen for it. */
const trialUnavailable = () =>
  ApiError.conflict(
    'A trial is not available for this organization. It is offered once per organization creator, to an organization that has never had a subscription.',
    { reason: 'trial_unavailable' }
  );

/** The owner re-read from `memberships`, never the token, as `startTrial` does. */
const assertOwner = async (userId, organizationId, action, trx) => {
  const membership = await organizations.findMembership(userId, organizationId, trx);
  if (membership?.role !== 'owner') {
    throw new ApiError('ROLE_FORBIDDEN', {
      message: `Only the owner can ${action}.`,
      details: { role: membership?.role ?? null },
    });
  }
};

/** One period as a client sees it. */
const presentPeriod = (row) =>
  row
    ? { id: row.id, kind: row.kind, plan: row.plan, periodStart: row.period_start, periodEnd: row.period_end }
    : null;

/**
 * An organization's subscriptions (ADR 0005): the trial and promo redemption
 * are written here.
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

  /**
   * Start the organization's trial: `pro`, from now, for `BILLING.TRIAL_DAYS`.
   *
   * Owner only. `billing:manage` at the gate, and the role re-read from
   * `memberships` here, because a previous owner's token still says owner for a
   * while after a transfer.
   *
   * The organization row is locked before availability is re-checked, so a
   * second request for the same organization waits and then sees the first
   * one's row. The lock cannot cover another organization of the same creator;
   * `subscriptions_trial_creator_uq` does, and losing that race is the same
   * refusal as losing the re-check.
   *
   * Returns the subscription view and a fresh session for this organization,
   * minted after the commit through the one choke point, so the trial's plan is
   * on the caller's token at once. Colleagues pick it up at their next refresh.
   */
  static async startTrial({ userId, organizationId }) {
    const user = await users.findById(userId);
    if (!user) throw ApiError.unauthenticated();

    const planId = await promoCodes.planIdByName(TRIAL_PLAN);
    if (!planId) throw new Error(`[subscriptions] plan "${TRIAL_PLAN}" is not seeded`);

    await withTransaction(async (trx) => {
      await organizations.lockForUpdate(organizationId, trx);
      const organization = await organizations.findById(organizationId, trx);
      if (!organization) throw ApiError.notFound('Organization');

      await assertOwner(user.id, organizationId, 'start a trial', trx);

      const [everHad, creatorHadTrial] = await Promise.all([
        subscriptions.everHad(organizationId, trx),
        subscriptions.creatorHasTrial(organization.created_by, trx),
      ]);
      if (everHad || creatorHadTrial) throw trialUnavailable();

      const id = await subscriptions.createTrial(
        { organizationId, planId, creatorId: organization.created_by, days: BILLING.TRIAL_DAYS },
        trx
      );
      if (!id) throw trialUnavailable();
    });

    logger.info(`[subscriptions] trial started for ${organizationId} by ${user.id} (${BILLING.TRIAL_DAYS} days)`);

    return {
      subscription: await SubscriptionService.current(organizationId),
      session: await AuthService.sessionFor(user, organizationId),
    };
  }
}
