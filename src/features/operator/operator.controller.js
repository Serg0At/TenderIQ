import PromoCodeService from './promoCode.service.js';
import OperatorSubscriptionService from './operatorSubscription.service.js';
import { ok, created, paginated } from '../../utils/respond.js';

export default class OperatorController {
  static async createPromoCode(req, res) {
    return created(res, await PromoCodeService.create(req.user.id, req.body));
  }

  static async listPromoCodes(req, res) {
    const { rows, cursor, hasMore } = await PromoCodeService.list(req.query);
    return paginated(res, rows, { cursor, hasMore });
  }

  /** 200, not 204: the body says whether the code was deleted or disabled. */
  static async removePromoCode(req, res) {
    return ok(res, await PromoCodeService.remove(req.user.id, req.params.id));
  }

  static async listSubscriptions(req, res) {
    return ok(res, await OperatorSubscriptionService.listForOrganization(req.params.id));
  }

  static async voidSubscription(req, res) {
    return ok(res, await OperatorSubscriptionService.voidPeriod(req.user.id, req.params.id));
  }
}
