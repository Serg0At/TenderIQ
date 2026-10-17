import OrganizationService from './organization.service.js';
import { ok, created, noContent, paginated } from '../../utils/respond.js';

const actorOf = (req) => ({ userId: req.user.id, organizationId: req.user.organizationId });

export default class OrganizationController {
  /** 201 with a session: the organization exists and the caller is already inside it. */
  static async create(req, res) {
    return created(res, await OrganizationService.create(req.user.id, req.body));
  }

  static async settings(req, res) {
    return ok(res, await OrganizationService.settings(req.user.organizationId));
  }

  static async updateSettings(req, res) {
    return ok(res, await OrganizationService.updateSettings(req.user.organizationId, req.body));
  }

  static async fields(_req, res) {
    return ok(res, OrganizationService.fields());
  }

  static async changeMemberRole(req, res) {
    return ok(res, await OrganizationService.changeMemberRole(actorOf(req), req.params.userId, req.body));
  }

  static async removeMember(req, res) {
    await OrganizationService.removeMember(actorOf(req), req.params.userId);
    return noContent(res);
  }

  static async transferOwnership(req, res) {
    return ok(res, await OrganizationService.transferOwnership(actorOf(req), req.body));
  }

  static async deleteOrganization(req, res) {
    return ok(res, await OrganizationService.deleteOrganization(actorOf(req), req.body));
  }

  static async leave(req, res) {
    return ok(res, await OrganizationService.leave(actorOf(req)));
  }

  static async listMembers(req, res) {
    const { rows, cursor, hasMore } = await OrganizationService.listMembers(
      { organizationId: req.user.organizationId, role: req.user.role },
      req.query
    );
    return paginated(res, rows, { cursor, hasMore });
  }
}
