import SubscriptionService from './subscription.service.js';
import { ok, created } from '../../utils/respond.js';

export default class SubscriptionController {
  static async current(req, res) {
    return ok(res, await SubscriptionService.current(req.user.organizationId));
  }

  /** 201: a period now exists, and the session in the body already carries its plan. */
  static async startTrial(req, res) {
    return created(
      res,
      await SubscriptionService.startTrial({ userId: req.user.id, organizationId: req.user.organizationId })
    );
  }
}
