import TrackedTenderService from './trackedTender.service.js';
import { created, noContent, ok } from '../../utils/respond.js';

export default class SupplierIdentityController {
  static async list(req, res) {
    return ok(res, await TrackedTenderService.supplierIdentity(req.user.organizationId));
  }

  static async claim(req, res) {
    return created(res, await TrackedTenderService.claimSupplierParty(req.user.organizationId, req.body, req.user.id));
  }

  static async unclaim(req, res) {
    await TrackedTenderService.unclaimSupplierParty(req.user.organizationId, req.params.partyId);
    return noContent(res);
  }

  static async candidates(req, res) {
    return ok(res, await TrackedTenderService.supplierCandidates(req.query.q));
  }
}
