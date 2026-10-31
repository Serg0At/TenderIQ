import SubscriptionService from './subscription.service.js';
import { ok } from '../../utils/respond.js';

export default class SubscriptionController {
  static async current(req, res) {
    return ok(res, await SubscriptionService.current(req.user.organizationId));
  }
}
