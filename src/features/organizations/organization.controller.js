import OrganizationService from './organization.service.js';
import { created } from '../../utils/respond.js';

export default class OrganizationController {
  /** 201 with a session: the organization exists and the caller is already inside it. */
  static async create(req, res) {
    return created(res, await OrganizationService.create(req.user.id, req.body));
  }
}
