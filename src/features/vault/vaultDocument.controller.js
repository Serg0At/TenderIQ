import VaultDocumentService from './vaultDocument.service.js';
import { SUGGESTED_KINDS, CONTENT_TYPES } from '../../validations/schemas/vaultDocument.schema.js';
import { ok, created, noContent, paginated } from '../../utils/respond.js';
import config from '../../configs/variables.config.js';

export default class VaultDocumentController {
  static async list(req, res) {
    const { rows, cursor, hasMore } = await VaultDocumentService.list(
      req.user.organizationId,
      req.query
    );
    return paginated(res, rows, { cursor, hasMore });
  }

  static async summary(req, res) {
    return ok(res, await VaultDocumentService.summary(req.user.organizationId));
  }

  /**
   * What the client needs to build an upload form without hardcoding it: the
   * accepted types, the size cap and the suggested vocabulary for `kind`. Served
   * rather than documented, so a cap raised in config does not need a client
   * release to take effect.
   */
  static async options(_req, res) {
    return ok(res, {
      contentTypes: Object.keys(CONTENT_TYPES),
      maxUploadBytes: config.VAULT.MAX_UPLOAD_BYTES,
      // Suggestions, not an enum — `kind` accepts any slug. See the schema.
      suggestedKinds: SUGGESTED_KINDS,
      expiryWarnDays: config.VAULT.EXPIRY_WARN_DAYS,
    });
  }

  /**
   * 201, because a document row really is created — it just has no bytes yet.
   * The `upload` block is how they get there; `duplicate: true` with a null
   * `upload` means the organisation already holds this exact file.
   */
  static async register(req, res) {
    const result = await VaultDocumentService.register(
      req.user.organizationId,
      req.user.id,
      req.body
    );
    return created(res, result);
  }

  static async confirm(req, res) {
    return ok(res, await VaultDocumentService.confirm(req.user.organizationId, req.params.id));
  }

  static async detail(req, res) {
    return ok(res, await VaultDocumentService.detail(req.user.organizationId, req.params.id));
  }

  static async update(req, res) {
    return ok(res, await VaultDocumentService.update(req.user.organizationId, req.params.id, req.body));
  }

  static async remove(req, res) {
    await VaultDocumentService.remove(req.user.organizationId, req.params.id);
    return noContent(res);
  }

  /**
   * Returns the link in the envelope rather than redirecting to it.
   *
   * A 302 to a presigned URL would put a credential in a Location header and in
   * the browser's history, and it would break the `{ data, meta }` contract every
   * other endpoint keeps.
   */
  static async download(req, res) {
    return ok(res, await VaultDocumentService.downloadUrl(req.user.organizationId, req.params.id));
  }
}
