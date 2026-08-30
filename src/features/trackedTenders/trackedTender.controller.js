import TrackedTenderService from './trackedTender.service.js';
import { ok, created, noContent, paginated } from '../../utils/respond.js';

/**
 * No branching business logic here — every rule about what may follow what
 * lives in the service, so a worker calling the same service gets the same
 * answers as an HTTP client.
 */
export default class TrackedTenderController {
  static async list(req, res) {
    const { rows, cursor, hasMore } = await TrackedTenderService.list(req.user.organizationId, req.query);
    return paginated(res, rows, { cursor, hasMore });
  }

  static async board(req, res) {
    return ok(res, await TrackedTenderService.board(req.user.organizationId));
  }

  static async detail(req, res) {
    return ok(res, await TrackedTenderService.detail(req.user.organizationId, req.params.id));
  }

  /**
   * 201 on a new pursuit, 200 when it was already tracked. The status code is
   * the only way a client can tell an idempotent repeat from a fresh create,
   * and both are successes.
   */
  static async track(req, res) {
    const { created: isNew, trackedTender } = await TrackedTenderService.track(
      req.user.organizationId,
      req.body
    );
    return isNew ? created(res, trackedTender) : ok(res, trackedTender);
  }

  static async update(req, res) {
    return ok(res, await TrackedTenderService.update(req.user.organizationId, req.params.id, req.body));
  }

  static async remove(req, res) {
    await TrackedTenderService.remove(req.user.organizationId, req.params.id);
    return noContent(res);
  }

  static async saveBid(req, res) {
    return ok(res, await TrackedTenderService.saveBid(req.user.organizationId, req.params.id, req.body));
  }

  static async submitBid(req, res) {
    return ok(res, await TrackedTenderService.submitBid(req.user.organizationId, req.params.id, req.body));
  }

  static async removeBid(req, res) {
    await TrackedTenderService.removeBid(req.user.organizationId, req.params.id);
    return noContent(res);
  }

  static async performance(req, res) {
    return ok(res, await TrackedTenderService.performance(req.user.organizationId));
  }
}
