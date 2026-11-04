import ChecklistService from './checklist.service.js';
import { ok, created, noContent } from '../../utils/respond.js';

export default class ChecklistController {
  static async get(req, res) {
    return ok(res, await ChecklistService.forTracked(req.user.organizationId, req.params.id));
  }

  /**
   * 202 Accepted, not 200.
   *
   * The work has not happened yet — a model call over a full invitation takes
   * tens of seconds. Returning 200 with a `pending` body would invite a client
   * to render an empty checklist as the answer.
   */
  static async generate(req, res) {
    const result = await ChecklistService.generate(req.user.organizationId, req.params.id, req.body, {
      userId: req.user.id,
    });
    return res.status(202).json({ data: result });
  }

  static async addItem(req, res) {
    return created(res, await ChecklistService.addItem(req.user.organizationId, req.params.id, req.body));
  }

  static async updateItem(req, res) {
    return ok(res, await ChecklistService.updateItem(req.user.organizationId, req.params.itemId, req.body));
  }

  /**
   * Attach a vault document to a requirement, or detach one with `null`.
   *
   * PATCH on its own subpath rather than a field on the item PATCH: attaching is
   * guarded by BR-12 and can be refused with a 409, which is not how a client
   * expects a field assignment to behave.
   */
  static async attachDocument(req, res) {
    return ok(
      res,
      await ChecklistService.attachDocument(
        req.user.organizationId,
        req.params.itemId,
        req.body.vaultDocumentId
      )
    );
  }

  static async removeItem(req, res) {
    await ChecklistService.removeItem(req.user.organizationId, req.params.itemId);
    return noContent(res);
  }
}
