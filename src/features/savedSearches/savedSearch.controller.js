import SavedSearchService from './savedSearch.service.js';
import { ok, created, noContent } from '../../utils/respond.js';

export default class SavedSearchController {
  static async list(req, res) {
    return ok(res, await SavedSearchService.list(req.user.organizationId));
  }

  static async create(req, res) {
    return created(res, await SavedSearchService.create(req.user.organizationId, req.body));
  }

  static async update(req, res) {
    return ok(res, await SavedSearchService.update(req.user.organizationId, req.params.id, req.body));
  }

  static async remove(req, res) {
    await SavedSearchService.remove(req.user.organizationId, req.params.id);
    return noContent(res);
  }
}
