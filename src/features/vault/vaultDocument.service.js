import vaultDocuments from '../../repositories/vaultDocument.repo.js';
import checklists from '../../repositories/checklist.repo.js';
import { getStorage, vaultKey } from '../../libs/storage/index.js';
import { CONTENT_TYPES } from '../../validations/schemas/vaultDocument.schema.js';
import { ApiError } from '../../utils/errors.js';
import config from '../../configs/variables.config.js';
import { logger } from '../../utils/logger.js';

const { VAULT } = config;

/**
 * The document vault.
 *
 * An organisation's reusable certificates and licences, with expiry tracked so
 * an expired one can never be attached to a bid (BR-12).
 *
 * Uploading is a three-step handshake rather than a POST of bytes:
 *
 *   1. `register` — the client says what it is about to send; the API mints a
 *      tenant-namespaced key from the content hash and returns a presigned PUT.
 *   2. the client uploads straight to object storage.
 *   3. `confirm` — the API asks storage whether the object actually arrived.
 *
 * The alternative — streaming the file through this process — was rejected for
 * the reason `app.js` caps JSON bodies at 1 MB: a 20 MB scan through an express
 * handler is memory pressure on the process serving every other request, and
 * the API would be the bottleneck for the one operation that has no business
 * touching it. The cost is step 3, without which an abandoned upload is
 * indistinguishable from a real document.
 *
 * The key is minted HERE and never accepted from the client. A presigned PUT is
 * a write capability, so a client-supplied key would be a client-supplied write
 * target — one tenant writing into another's prefix.
 */

/**
 * Object storage being unreachable is a dependency failure, not a bug.
 *
 * Without this it surfaces as INTERNAL_ERROR: `head()` maps a 404 to null but
 * lets a connection fault through, and the error handler treats anything that
 * is not an ApiError as an unexpected exception. A customer whose upload cannot
 * be confirmed because MinIO is down deserves a 503 that says to retry, not a
 * 500 that says we are broken. Verified — confirming against a stopped MinIO
 * answered 500 before this existed.
 */
const asDependencyFailure = (error, action) => {
  logger.error(`[vault] storage ${action} failed: ${error.message}`);
  return new ApiError('DEPENDENCY_UNAVAILABLE', {
    message: 'Document storage is temporarily unavailable.',
  });
};

/**
 * The widest warning threshold doubles as the "expiring soon" line, so the
 * status a client renders and the moment an alert fires cannot drift apart.
 */
const EXPIRING_SOON_DAYS = VAULT.EXPIRY_WARN_DAYS[0];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Expiry is DERIVED, never stored.
 *
 * The contrast with `checklist_items.needs_review` is deliberate: that flag is
 * stored because a human clears it, and recomputing it would re-open items
 * someone had already reviewed. Nothing here is cleared by a person — it is a
 * pure function of `valid_until` and the clock — so a stored copy could only
 * ever be stale.
 */
export const expiryOf = (validUntil, now = new Date()) => {
  if (!validUntil) return { status: 'no_expiry', daysRemaining: null, validUntil: null };

  const at = new Date(validUntil);
  const days = Math.ceil((at.getTime() - now.getTime()) / DAY_MS);

  return {
    status: days <= 0 ? 'expired' : days <= EXPIRING_SOON_DAYS ? 'expiring_soon' : 'valid',
    daysRemaining: days,
    validUntil: at.toISOString(),
  };
};

/**
 * `storage_key` and `hash` are not on the wire.
 *
 * The key is an internal address in a bucket the client has no direct access
 * to, and publishing it invites someone to construct their own — which is the
 * one thing tenant namespacing exists to prevent. Downloads go through
 * `downloadUrl`, which re-checks the organisation.
 */
const present = (row, now = new Date()) => ({
  id: row.id,
  kind: row.kind,
  filename: row.filename,
  contentType: row.content_type,
  sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
  status: row.status,
  issuedAt: row.issued_at ?? null,
  notes: row.notes ?? null,
  expiry: expiryOf(row.valid_until, now),
  createdAt: row.created_at,
  updatedAt: row.updated_at ?? null,
});

export default class VaultDocumentService {
  static async list(organizationId, { filter = {}, page = {} } = {}) {
    const { rows, cursor, hasMore } = await vaultDocuments.listForOrg(organizationId, {
      kind: filter.kind ?? null,
      status: filter.status === 'all' ? null : filter.status ?? 'ready',
      limit: page.size ?? 20,
      cursor: page.cursor ?? null,
    });

    const now = new Date();
    return { rows: rows.map((row) => present(row, now)), cursor, hasMore };
  }

  /** Counts per kind, with how many have lapsed — the header a vault list needs. */
  static async summary(organizationId) {
    return { byKind: await vaultDocuments.summaryForOrg(organizationId) };
  }

  static async detail(organizationId, id) {
    const row = await vaultDocuments.findRow(id, organizationId);
    if (!row) throw ApiError.notFound('Vault document');
    return present(row);
  }

  /**
   * Step 1: reserve the row and hand back a presigned PUT.
   *
   * A hash the organisation already holds is not an error — it is the same
   * document — so this answers with the existing row and no upload URL rather
   * than a 409 the customer would have to interpret. That is the spec's
   * "duplicate document → dedupe by content hash", and it means re-uploading a
   * file you already have is a no-op instead of a second copy.
   */
  static async register(organizationId, userId, input) {
    const ext = CONTENT_TYPES[input.contentType];
    // Unreachable through the HTTP boundary — Joi already restricts the type to
    // this map's keys — but the map and the schema are two files, and a key
    // added to one and not the other must not produce an object named `.bin`.
    if (!ext) throw ApiError.validation([{ field: 'contentType', message: 'Unsupported content type.' }]);

    const existing = await vaultDocuments.findByHash(organizationId, input.sha256);
    if (existing && existing.status === 'ready') {
      return { document: present(existing), duplicate: true, upload: null };
    }

    const storageKey = vaultKey({ organizationId, hash: input.sha256, ext });

    /**
     * A previous attempt that never completed is retried in place rather than
     * conflicting: the (organization_id, hash) index would refuse a second row,
     * and telling a customer "you already uploaded this" about a file that never
     * arrived is the worst of both answers.
     */
    const { row } = existing
      ? { row: existing }
      : await vaultDocuments.register({
          organizationId,
          kind: input.kind,
          hash: input.sha256,
          storageKey,
          filename: input.filename,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          validUntil: input.validUntil ?? null,
          issuedAt: input.issuedAt ?? null,
          notes: input.notes ?? null,
          uploadedByUserId: userId ?? null,
        });

    const storage = await getStorage();
    let presigned;
    try {
      presigned = await storage.signedUploadUrl(row.storage_key, {
        contentType: input.contentType,
        contentLength: input.sizeBytes,
        ttlSeconds: VAULT.UPLOAD_URL_TTL_SECONDS,
      });
    } catch (error) {
      /**
       * The local filesystem driver cannot presign at all. That is a deployment
       * problem, not a client one, so it answers 503 with the fix in the message
       * rather than a 500 that reads as a bug.
       */
      logger.error(`[vault] presign failed: ${error.message}`);
      throw new ApiError('DEPENDENCY_UNAVAILABLE', {
        message: 'Document uploads are not available with the current storage driver.',
      });
    }

    return {
      document: present(row),
      duplicate: false,
      upload: {
        url: presigned.url,
        method: 'PUT',
        /**
         * Handed back rather than left to the client to guess: every one of
         * these is signed into the URL, so a PUT that changes or omits any of
         * them fails the signature and is rejected by storage with no
         * explanation the client could act on.
         */
        headers: presigned.headers,
        expiresIn: VAULT.UPLOAD_URL_TTL_SECONDS,
      },
    };
  }

  /**
   * Step 3: did the bytes actually arrive?
   *
   * This process never observes the upload, so the only honest way to answer is
   * to ask storage. A missing object leaves the row `pending` — retryable with a
   * fresh URL — rather than marking it rejected, because the usual cause is a
   * client that simply has not finished yet.
   *
   * The size storage reports overwrites the one the client declared. The
   * declared size is a hint used to bound the presigned URL; this is the fact.
   */
  static async confirm(organizationId, id) {
    const row = await vaultDocuments.findRow(id, organizationId);
    if (!row) throw ApiError.notFound('Vault document');
    if (row.status === 'ready') return present(row);
    if (row.status === 'rejected') {
      throw ApiError.conflict('This upload was rejected and cannot be confirmed.');
    }

    const storage = await getStorage();
    let object;
    try {
      object = await storage.head(row.storage_key);
    } catch (error) {
      throw asDependencyFailure(error, 'head');
    }

    if (!object) {
      throw ApiError.conflict('No uploaded file found for this document yet.', {
        documentId: id,
        hint: 'Complete the presigned PUT before confirming.',
      });
    }

    /**
     * Belt and braces on the size cap. Storage enforces the signed
     * ContentLength, so this should be unreachable — but the cap is the one
     * limit protecting the vault from being used as general file hosting, and a
     * driver or gateway that ignores the signed length must not quietly succeed.
     */
    if (Number(object.size) > VAULT.MAX_UPLOAD_BYTES) {
      await vaultDocuments.reject({
        organizationId,
        id,
        reason: `Uploaded file exceeds the ${VAULT.MAX_UPLOAD_BYTES} byte limit.`,
      });
      throw ApiError.validation([{ field: 'sizeBytes', message: 'The uploaded file is too large.' }]);
    }

    return present(await vaultDocuments.confirm({ id, organizationId, sizeBytes: object.size }));
  }

  static async update(organizationId, id, patch) {
    const row = await vaultDocuments.update(id, organizationId, patch);
    if (!row) throw ApiError.notFound('Vault document');
    return present(row);
  }

  /**
   * Erase a document, file included.
   *
   * The object goes first and the row second. A failure to delete the bytes then
   * leaves both intact and the request retryable — the alternative ordering
   * would report success to a customer asking for erasure while the file
   * remained, which is the one failure mode this operation must not have.
   *
   * Checklist items pointing at it survive, detached. The requirement did not
   * stop existing; it is simply unmet again — and the count is returned so the
   * caller can say so. Detaching is explicit rather than left to the foreign
   * key, because the key can only clear the pointer and would leave
   * `attached_at` claiming a document that is gone.
   */
  static async remove(organizationId, id) {
    const row = await vaultDocuments.findRow(id, organizationId);
    if (!row) throw ApiError.notFound('Vault document');

    const attachedTo = await checklists.itemsUsingDocument(id, organizationId);

    const storage = await getStorage();
    try {
      await storage.remove(row.storage_key);
    } catch (error) {
      // The row is deliberately left intact: reporting a successful erasure
      // while the file survives is the one failure this operation must not have.
      throw asDependencyFailure(error, 'remove');
    }
    await checklists.detachDocument(id, organizationId);
    await vaultDocuments.remove(id, organizationId);

    return { deleted: true, detachedChecklistItems: attachedTo.length };
  }

  /**
   * A time-limited link to the bytes.
   *
   * Short-lived because it is minted on every view rather than once per upload,
   * and because the URL itself is the only thing standing between the object and
   * anyone it is forwarded to — the bucket is private and has no other reader.
   */
  static async downloadUrl(organizationId, id) {
    const row = await vaultDocuments.findRow(id, organizationId);
    if (!row) throw ApiError.notFound('Vault document');
    if (row.status !== 'ready') {
      throw ApiError.conflict('This document has no uploaded file to download.');
    }

    const storage = await getStorage();
    let url;
    try {
      url = await storage.signedUrl(row.storage_key, VAULT.DOWNLOAD_URL_TTL_SECONDS);
    } catch (error) {
      throw asDependencyFailure(error, 'sign');
    }

    return {
      url,
      expiresIn: VAULT.DOWNLOAD_URL_TTL_SECONDS,
      filename: row.filename,
      contentType: row.content_type,
    };
  }

  /**
   * BR-12, enforced: an expired certificate cannot be attached to a bid.
   *
   * Lives here rather than in the checklist service because it is a fact about a
   * vault document, and the next attachment point — the bid package, phase 5 —
   * must ask the same question and get the same answer. A rule re-implemented at
   * each call site is a rule that will eventually disagree with itself.
   *
   * A document with no `valid_until` passes: null means "does not expire", not
   * "unknown". A `pending` one does not — there is no file behind it.
   */
  static async assertAttachable(organizationId, id, { now = new Date() } = {}) {
    const row = await vaultDocuments.findRow(id, organizationId);
    if (!row) throw ApiError.notFound('Vault document');

    if (row.status !== 'ready') {
      throw ApiError.conflict('That document has not finished uploading.', { documentId: id });
    }

    const expiry = expiryOf(row.valid_until, now);
    if (expiry.status === 'expired') {
      throw ApiError.conflict('That document expired and cannot be attached to a bid.', {
        documentId: id,
        validUntil: expiry.validUntil,
      });
    }

    return row;
  }
}
