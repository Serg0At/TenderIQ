import InvitationService from './invitation.service.js';
import { ok, noContent, paginated } from '../../utils/respond.js';

const actorOf = (req) => ({ userId: req.user.id, organizationId: req.user.organizationId });

export default class InvitationController {
  /**
   * 200 with the same constant for every address. Not 201: a 201 would
   * describe what happened to a row, and what happened is exactly what this
   * response must not vary by.
   */
  static async send(req, res) {
    return ok(res, await InvitationService.send(actorOf(req), req.body));
  }

  static async listMine(req, res) {
    const { rows, cursor, hasMore } = await InvitationService.listMine(req.user.id, req.query);
    return paginated(res, rows, { cursor, hasMore });
  }

  static async accept(req, res) {
    return ok(res, await InvitationService.accept(actorOf(req), req.params.id));
  }

  static async decline(req, res) {
    return ok(res, await InvitationService.decline(req.user.id, req.params.id));
  }

  static async list(req, res) {
    const { rows, cursor, hasMore } = await InvitationService.list(req.user.organizationId, req.query);
    return paginated(res, rows, { cursor, hasMore });
  }

  static async cancel(req, res) {
    await InvitationService.cancel(req.user.organizationId, req.params.id);
    return noContent(res);
  }
}
