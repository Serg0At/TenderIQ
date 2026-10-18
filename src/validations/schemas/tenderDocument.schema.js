import Joi from 'joi';
import { LANGUAGES } from '../../libs/documentLanguage.js';

const uint32 = Joi.number().integer().min(0).max(0xffffffff);

/**
 * A stored archive's file list, checked before it reaches `tender_documents`.
 *
 * Entry names are source text, and the offsets are what a download seeks to,
 * so a malformed manifest must fail here rather than become a row the API
 * later trusts. Unknown keys are refused rather than stripped: this is our own
 * output, and an unexpected field means the builder changed without this.
 */
const manifestEntrySchema = Joi.object({
  index: Joi.number().integer().min(0).required(),
  path: Joi.string().min(1).max(1024).required(),
  name: Joi.string().min(1).max(1024).required(),
  ext: Joi.string().max(16).allow(null).required(),
  size: uint32.required(),
  language: Joi.string()
    .valid(...LANGUAGES)
    .allow(null)
    .required(),
  offset: uint32.required(),
  compressedSize: uint32.required(),
  method: Joi.number().integer().min(0).required(),
  crc32: uint32.required(),
  encrypted: Joi.boolean().required(),
});

export const tenderDocumentManifestSchema = Joi.array()
  .items(manifestEntrySchema)
  .unique((a, b) => a.index === b.index)
  .required();

/** `GET /tenders/:id/documents/:documentId/files/:index` — the index arrives as a string. */
export const tenderDocumentFileParamsSchema = Joi.object({
  id: Joi.string().max(64).required(),
  documentId: Joi.string().max(64).required(),
  index: Joi.number().integer().min(0).max(65535).required(),
});

export default { tenderDocumentManifestSchema, tenderDocumentFileParamsSchema };
