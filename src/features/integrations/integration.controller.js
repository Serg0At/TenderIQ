import TelegramLinkService from '../../services/telegramLink.service.js';
import { ok, created, noContent } from '../../utils/respond.js';

export default class IntegrationController {
  /**
   * Start linking a Telegram chat.
   *
   * POST rather than GET because it mints a single-use credential and writes a
   * row — a GET would be pre-fetched by browsers and link previews, burning
   * tokens nobody asked for.
   */
  static async createTelegramLink(req, res) {
    const link = await TelegramLinkService.createLink({
      organizationId: req.user.organizationId,
      userId: req.user.id,
    });
    return created(res, link);
  }

  static async listTelegramLinks(req, res) {
    return ok(res, await TelegramLinkService.listLinks(req.user.organizationId));
  }

  static async unlinkTelegram(req, res) {
    await TelegramLinkService.unlink({
      organizationId: req.user.organizationId,
      id: req.params.id,
    });
    return noContent(res);
  }

  static async setQuietHours(req, res) {
    const { start, end, timezone } = req.body;
    return ok(
      res,
      await TelegramLinkService.setQuietHours({
        organizationId: req.user.organizationId,
        id: req.params.id,
        start,
        end,
        timezone,
      })
    );
  }
}
