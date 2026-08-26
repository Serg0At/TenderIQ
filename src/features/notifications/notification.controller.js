import NotificationService from './notification.service.js';
import { ok } from '../../utils/respond.js';

export default class NotificationController {
  static async list(req, res) {
    return ok(res, await NotificationService.list(req.user.organizationId, { limit: req.query.limit }));
  }

  static async markRead(req, res) {
    return ok(res, await NotificationService.markRead(req.user.organizationId, req.params.id));
  }
}
