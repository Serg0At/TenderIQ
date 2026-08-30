import TrackedTenderService from './trackedTender.service.js';
import { ok } from '../../utils/respond.js';

export default class SupplierIdentityController {
  static async get(req, res) {
    return ok(res, await TrackedTenderService.supplierIdentity(req.user.organizationId));
  }

  static async set(req, res) {
    return ok(res, await TrackedTenderService.setSupplierIdentity(req.user.organizationId, req.body));
  }

  static async candidates(req, res) {
    return ok(res, await TrackedTenderService.supplierCandidates(req.query.q));
  }
}
