import Joi from 'joi';

/**
 * Shape of a tender as mapped from a source detail page, validated before it
 * reaches the database.
 *
 * `buyerId` is absent on purpose: the buyer is resolved to a party inside the
 * repository transaction, so it does not exist yet at validation time.
 *
 * Enums are pinned here rather than left as free strings — the source publishes
 * Armenian lifecycle labels, and this is the boundary where an unmapped one has
 * to fail instead of reaching a column every downstream filter reads.
 */
export const PROCEDURE_TYPES = ['open', 'quotation', 'single_source', 'e_auction', 'restricted'];
export const TENDER_STATUSES = ['planned', 'active', 'amended', 'closed', 'awarded', 'cancelled'];
/** How a supplier submits a bid (ADR 0004). Mirrors `tenders_submission_channel_chk`. */
export const SUBMISSION_CHANNELS = ['eauction', 'armeps', 'paper'];

export const normalizedTenderSchema = Joi.object({
  title: Joi.string().trim().min(1).required(),
  referenceCode: Joi.string().trim().allow(null),
  procedureType: Joi.string()
    .valid(...PROCEDURE_TYPES)
    .required(),
  goodsWorksServices: Joi.string().trim().allow(null),
  // A code derived from the source's label (`lowest_price`), never free text.
  evaluationMethod: Joi.string().pattern(/^[a-z0-9_]+$/).allow(null),
  // Where a paper bid is delivered, as the invitation states it. Source text.
  submissionAddress: Joi.string().trim().max(1000).allow(null),
  status: Joi.string()
    .valid(...TENDER_STATUSES)
    .required(),
  submissionChannel: Joi.string()
    .valid(...SUBMISSION_CHANNELS)
    .required(),
  // Free text on purpose: this is the source's own label, and constraining it
  // to a known set would defeat the point of keeping it.
  sourceStatus: Joi.string().trim().allow(null, ''),
  currency: Joi.string().length(3).required(),
  cpvCode: Joi.string().trim().allow(null),
  // Every code the source states. Null is silence — the source states its codes
  // somewhere else (e-auction: the invitation archive) — never "none".
  cpvCodes: Joi.array().items(Joi.string().trim().pattern(/^\d{8}$/)).allow(null),
  description: Joi.string().trim().allow(null, ''),
  estimatedValue: Joi.number().precision(2).allow(null),
  publishedAt: Joi.date().allow(null),
  deadlineAt: Joi.date().allow(null),
  qnaDeadlineAt: Joi.date().allow(null),
  auctionAt: Joi.date().allow(null),
  invitationUrl: Joi.string().uri().allow(null),
})
  .required()
  // Whitelist: anything a mapper adds without a rule here is dropped rather
  // than carried into a repository that would try to write it as a column.
  .options({ stripUnknown: true });

export default normalizedTenderSchema;
