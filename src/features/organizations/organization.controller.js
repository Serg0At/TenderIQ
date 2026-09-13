import OrganizationService from './organization.service.js';
import { ok, created, paginated } from '../../utils/respond.js';

export default class OrganizationController {
  /** 201 with a session: the organization exists and the caller is already inside it. */
  static async create(req, res) {
    return created(res, await OrganizationService.create(req.user.id, req.body));
  }

  static async changeMemberRole(req, res) {
    const actor = { userId: req.user.id, organizationId: req.user.organizationId };
    return ok(res, await OrganizationService.changeMemberRole(actor, req.params.userId, req.body));
  }

  static async listMembers(req, res) {
    const { rows, cursor, hasMore } = await OrganizationService.listMembers(
      { organizationId: req.user.organizationId, role: req.user.role },
      req.query
    );
    return paginated(res, rows, { cursor, hasMore });
  }
}
