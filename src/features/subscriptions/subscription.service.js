import config from '../../configs/variables.config.js';
import { withTransaction } from '../../libs/knex.js';
import subscriptions from '../../repositories/subscription.repo.js';
import organizations from '../../repositories/organization.repo.js';
import promoCodes from '../../repositories/promoCode.repo.js';
import users from '../../repositories/user.repo.js';
import AuthService from '../auth/auth.service.js';
import QuotaService from './quota.service.js';
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

/**
 * The one answer for an unknown, disabled, past-deadline or used-up code, as a
 * module constant rather than a string in four branches: any difference in
 * wording or shape between them would tell a guesser which codes exist.
 */
const CODE_INVALID = Object.freeze({
  message: 'That code cannot be redeemed. Check it with whoever gave it to you.',
  details: Object.freeze({ reason: 'code_invalid' }),
});

const codeInvalid = () => new ApiError('VALIDATION_FAILED', CODE_INVALID);

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
   * subscription and the person who created it has never claimed a trial. Both
   * outlast a void, and the claim outlasts the organization it was made in: a
   * creator who deletes their organization does not get a second trial.
   *
   * `quota` is `QuotaService.read`, the one computation the generate request
   * enforces, so the view and the 429 can never disagree.
   */
  static async current(organizationId) {
    const organization = await organizations.findById(organizationId);
    if (!organization) throw ApiError.notFound('Organization');

    const [current, next, everHad, creatorHadTrial, quota] = await Promise.all([
      subscriptions.current(organizationId),
      subscriptions.next(organizationId),
      subscriptions.everHad(organizationId),
      subscriptions.hasClaimedTrial(organization.created_by),
      QuotaService.read(organizationId),
    ]);

    return {
      current: presentPeriod(current),
      next: presentPeriod(next),
      trialAvailable: !everHad && !creatorHadTrial,
      quota,
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
   * the creator's `trial_claims` row does, inserted in the same transaction,
   * and losing that race is the same refusal as losing the re-check.
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
        subscriptions.hasClaimedTrial(organization.created_by, trx),
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

  /**
   * Redeem a promo code: a 100% code becomes a `promo` period of the code's
   * plan, lasting its `duration_months` calendar months. There is no checkout,
   * so anything below 100% is refused before a row is written.
   *
   * Owner only, re-checked against `memberships` like `startTrial`. One
   * transaction under the organization row lock, checked in this order:
   *
   *   1. the code is unknown, disabled or past its deadline, or it is used up
   *      and this organization is not one of its redeemers → `code_invalid`,
   *      one constant answer for all four;
   *   2. it is below 100% → `payments_unavailable`;
   *   3. a promo or paid period has not ended, scheduled ones included →
   *      `promo_active`;
   *   4. this organization redeemed the code before, voided included →
   *      `already_redeemed`, even when the code is used up since: an owner
   *      re-typing a one-use code they spent is told so, not that it is wrong;
   *   5. a trial is running and `trial` is missing → the field is named.
   *
   * A used-up code still reads as `code_invalid` to every other organization, so
   * the four stay one answer to a guesser; only an organization that redeemed
   * the code, and therefore knows it, learns anything more.
   *
   * During a trial, `keep` starts the promo where the trial ends and `end`
   * shortens the trial to now and starts the promo now; with no period it
   * starts now. The count rises through a conditional UPDATE, so the limit holds
   * under concurrent redemptions from other organizations, which this lock does
   * not cover: losing that race is `code_invalid`. The index on
   * (promo_code_id, organization_id) is the last word on `already_redeemed`.
   *
   * Returns the subscription view and a fresh session, as `startTrial` does. Its
   * plan is the code's, unless the promo waits behind a kept trial — then it is
   * the trial's until the trial ends.
   */
  static async redeem({ userId, organizationId, code, trial }) {
    const user = await users.findById(userId);
    if (!user) throw ApiError.unauthenticated();

    let redeemed;
    await withTransaction(async (trx) => {
      await organizations.lockForUpdate(organizationId, trx);
      await assertOwner(user.id, organizationId, 'redeem a promo code', trx);

      const promo = await promoCodes.findByCode(code, trx);
      if (!promo?.open) throw codeInvalid();
      const redeemedBefore = await subscriptions.hasRedeemed(organizationId, promo.id, trx);
      if (!promo.redeemable && !redeemedBefore) throw codeInvalid();
      if (promo.percent_off < 100) {
        throw new ApiError('VALIDATION_FAILED', {
          message: 'This code is a discount, and payments are not available yet. Only a 100% code can be redeemed today.',
          details: { reason: 'payments_unavailable', percentOff: promo.percent_off },
        });
      }

      if (await subscriptions.unendedGrant(organizationId, trx)) {
        throw ApiError.conflict(
          'This organization is already on a promo period. Another code can be redeemed once it ends.',
          { reason: 'promo_active' }
        );
      }
      const alreadyRedeemed = () =>
        ApiError.conflict('This organization has already redeemed that code.', { reason: 'already_redeemed' });
      if (redeemedBefore) throw alreadyRedeemed();

      const current = await subscriptions.current(organizationId, trx);
      const duringTrial = current?.kind === 'trial';
      if (duringTrial && !trial) {
        throw ApiError.validation([
          { field: 'trial', message: '"trial" is required during a trial: "keep" the remaining days, or "end" the trial now' },
        ]);
      }

      if (duringTrial && trial === 'end' && !(await subscriptions.endTrialNow(current.id, organizationId, trx))) {
        throw new Error(`[subscriptions] trial ${current.id} could not be ended`);
      }

      if (!(await promoCodes.countRedemption(promo.id, trx))) throw codeInvalid();

      const id = await subscriptions.createPromo(
        {
          organizationId,
          planId: promo.plan_id,
          promoCodeId: promo.id,
          months: promo.duration_months,
          after: duringTrial && trial === 'keep' ? current.id : null,
        },
        trx
      );
      if (!id) throw alreadyRedeemed();
      redeemed = { id, promoCodeId: promo.id, trial: duringTrial ? trial : null };
    });

    logger.info(
      `[subscriptions] promo ${redeemed.promoCodeId} redeemed for ${organizationId} by ${user.id}` +
        (redeemed.trial ? ` (trial: ${redeemed.trial})` : '')
    );

    return {
      subscription: await SubscriptionService.current(organizationId),
      session: await AuthService.sessionFor(user, organizationId),
    };
  }
}
