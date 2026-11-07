import TelegramLinkService from '../../services/telegramLink.service.js';
import EmailAlertsService from '../../services/emailAlerts.service.js';
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

  /**
   * Switch a chat that was turned off back on.
   *
   * `userId` is passed where the unlink handler passes none, and that is the
   * whole difference between the two: turning alerts off for someone is safe,
   * turning them on is sending messages to their private chat, so only the
   * owner can. See `channelSubscription.repo.js:reactivate`.
   */
  static async enableTelegram(req, res) {
    return ok(
      res,
      await TelegramLinkService.enable({
        organizationId: req.user.organizationId,
        userId: req.user.id,
        id: req.params.id,
      })
    );
  }

  /**
   * Switch the caller's own chat between `instant` and `daily`.
   *
   * Self-scoped like `enableTelegram`, and for the same reason: when a private
   * chat hears about a match is its owner's choice, so a colleague's id is not
   * found. A switch to instant flushes what was held as one digest.
   */
  static async setTelegramCadence(req, res) {
    return ok(
      res,
      await TelegramLinkService.setCadence({
        organizationId: req.user.organizationId,
        userId: req.user.id,
        id: req.params.id,
        cadence: req.body.cadence,
      })
    );
  }

  /**
   * Email alerts for the organization.
   *
   * The mirror of the Telegram handlers, and the replacement for what used to
   * live in `PATCH /notifications/preferences`. A subscription row is the only
   * switch, so switching email on and linking a chat are the same kind of act
   * and sit behind the same permission.
   */
  static async listEmailAlerts(req, res) {
    return ok(res, await EmailAlertsService.list(req.user.organizationId));
  }

  static async subscribeEmail(req, res) {
    return created(
      res,
      await EmailAlertsService.subscribe({
        organizationId: req.user.organizationId,
        userId: req.user.id,
      })
    );
  }

  static async unsubscribeEmail(req, res) {
    await EmailAlertsService.unsubscribe({
      organizationId: req.user.organizationId,
      id: req.params.id,
    });
    return noContent(res);
  }

  /** The email mirror of `enableTelegram`, and self-scoped for the same reason. */
  static async enableEmail(req, res) {
    return ok(
      res,
      await EmailAlertsService.enable({
        organizationId: req.user.organizationId,
        userId: req.user.id,
        id: req.params.id,
      })
    );
  }

  /** The email mirror of `setTelegramCadence`, and self-scoped for the same reason. */
  static async setEmailCadence(req, res) {
    return ok(
      res,
      await EmailAlertsService.setCadence({
        organizationId: req.user.organizationId,
        userId: req.user.id,
        id: req.params.id,
        cadence: req.body.cadence,
      })
    );
  }
}
