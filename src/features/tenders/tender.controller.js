import TenderService from './tender.service.js';
import { ok, paginated } from '../../utils/respond.js';

export default class TenderController {
  static async list(req, res) {
    const { rows, cursor, hasMore } = await TenderService.search(req.query);
    return paginated(res, rows, { cursor, hasMore });
  }

  static async detail(req, res) {
    return ok(res, await TenderService.detail(req.params.id));
  }
}
