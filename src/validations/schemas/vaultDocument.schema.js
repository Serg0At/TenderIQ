import Joi from 'joi';
import config from '../../configs/variables.config.js';

const { VAULT } = config;

/**
 * The vault's write shapes.
 *
 * The upload is a handshake, not a POST of bytes: the client declares what it
 * is about to send, gets a presigned PUT back, uploads, then confirms. So the
 * "create" schema validates a description of a file rather than a file — which
 * is also why the size and content type are checked twice, here against what
 * was declared and again on confirm against what storage actually holds.
 */

/**
 * What may be stored. An allow-list, not a deny-list: a vault holds
 * certificates, and anything outside this set is a mistake or an attempt to use
 * a tenant-scoped bucket as general file hosting.
 *
 * The extension is part of the storage key, so the mapping lives here rather
 * than being guessed from the filename — a client-supplied name is untrusted and
 * `cert.pdf.exe` must not decide how the object is stored.
 */
export const CONTENT_TYPES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/tiff': 'tif',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/zip': 'zip',
};

/**
 * A suggested vocabulary for the client, NOT a constraint.
 *
 * `kind` is deliberately free text in the column and here: the set of documents
 * a buyer can demand is defined by the tender, not by us, and an enum would
 * force a customer to file a real certificate under "other" the first time
 * Armenian procurement asks for something this list does not name.
 */
export const SUGGESTED_KINDS = [
  'tax-clearance',
  'company-registration',
  'bank-reference',
  'iso-certificate',
  'licence',
  'insurance',
  'financial-statement',
  'power-of-attorney',
  'reference-letter',
  'other',
];

const kind = Joi.string()
  .trim()
  .lowercase()
  // Slug-shaped so it can be filtered on and grouped by without normalising at
  // read time; free within that shape for the reason above.
  .pattern(/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/)
  .max(60);

export const registerVaultDocumentSchema = Joi.object({
  kind: kind.required(),
  filename: Joi.string().trim().min(1).max(255).required(),
  contentType: Joi.string()
    .valid(...Object.keys(CONTENT_TYPES))
    .required(),
  /**
   * sha256 of the bytes, computed by the client.
   *
   * It is the dedupe key and the tail of the storage key, so it must arrive
   * before the upload does. A wrong hash is self-inflicted — the key is
   * namespaced to the caller's own organisation, so the blast radius is their
   * own vault — but confirm() still verifies the object landed, so a lie
   * produces a rejected row rather than a phantom document.
   */
  sha256: Joi.string().trim().lowercase().length(64).hex().required(),
  sizeBytes: Joi.number().integer().min(1).max(VAULT.MAX_UPLOAD_BYTES).required(),
  /**
   * Null means "does not expire" — a company registration does not lapse — and
   * is the reason the column is nullable and the expiry index is partial. A past
   * date is accepted: a customer onboarding with history has expired
   * certificates, and refusing them would make the vault lie about what they hold.
   */
  validUntil: Joi.date().iso().allow(null).default(null),
  issuedAt: Joi.date().iso().max('now').allow(null).default(null),
  notes: Joi.string().trim().max(2000).allow(null, ''),
}).required();

export const updateVaultDocumentSchema = Joi.object({
  kind,
  filename: Joi.string().trim().min(1).max(255),
  validUntil: Joi.date().iso().allow(null),
  issuedAt: Joi.date().iso().max('now').allow(null),
  notes: Joi.string().trim().max(2000).allow(null, ''),
})
  .min(1)
  .required();

export const vaultQuerySchema = Joi.object({
  filter: Joi.object({
    kind: Joi.alternatives(Joi.array().items(kind), kind),
    /**
     * `expiring` and `expired` are derived from `valid_until` against the clock,
     * not stored — unlike a checklist's `needs_review`, which is stored because
     * a human clears it. Nothing here is cleared by a person, so recomputing on
     * read is correct and a stored copy would just go stale.
     */
    status: Joi.string().valid('ready', 'pending', 'rejected', 'all').default('ready'),
  }).default({}),
  page: Joi.object({
    size: Joi.number().integer().min(1).max(100).default(20),
    cursor: Joi.string().max(200).allow(null, ''),
  }).default({}),
}).options({ stripUnknown: true });

/**
 * Attaching a document to a checklist requirement. `null` detaches — which must
 * stay possible, since attaching the wrong certificate is the easiest mistake
 * in the feature.
 */
export const attachDocumentSchema = Joi.object({
  vaultDocumentId: Joi.string().trim().max(40).allow(null).required(),
}).required();

export default {
  CONTENT_TYPES,
  SUGGESTED_KINDS,
  registerVaultDocumentSchema,
  updateVaultDocumentSchema,
  vaultQuerySchema,
  attachDocumentSchema,
};
