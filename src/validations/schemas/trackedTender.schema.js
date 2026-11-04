import Joi from 'joi';

const STATUSES = ['considering', 'preparing', 'submitted', 'won', 'lost', 'dropped'];

/**
 * The pipeline's write shapes.
 *
 * These mirror the CHECK constraints added in `migrations/create_table.js`
 * rather than replacing them. Validating here gives the client a 422 naming the
 * field; the constraint is what guarantees no other writer — a worker, a
 * script, a future admin tool — can put an unknown status in the column.
 */

/**
 * The relevance a row of the relevant list showed, handed back verbatim when a
 * tender is tracked from that list. Verified against its signature in the
 * service; the shapes here only bound the size. `reasons` items keep every key
 * (`unknown`), because the signature covers them exactly as they were shown.
 * `tracking` is state, not ranking, and is dropped.
 */
const shownRelevanceSchema = Joi.object({
  score: Joi.number().min(0).max(1).required(),
  band: Joi.string().valid('strong', 'moderate', 'weak').required(),
  reasons: Joi.array().items(Joi.object().unknown(true)).max(20).required(),
  shownAt: Joi.string().isoDate().required(),
  signature: Joi.string().hex().length(64).required(),
  tracking: Joi.any().strip(),
});

/** Starting a pursuit. */
export const trackTenderSchema = Joi.object({
  tenderId: Joi.string().trim().max(40).required(),
  // A tender can be tracked straight into `preparing`, but not into a settled
  // or submitted state: those are reached by doing the thing, not by claiming it.
  status: Joi.string().valid('considering', 'preparing').default('considering'),
  goNoGo: Joi.string().valid('go', 'no_go', 'undecided').allow(null),
  decisionNote: Joi.string().trim().max(2000).allow(null, ''),
  // Only when tracking from the relevant list; omitted everywhere else.
  relevance: shownRelevanceSchema.allow(null),
}).required();

export const updateTrackedTenderSchema = Joi.object({
  status: Joi.string().valid(...STATUSES),
  goNoGo: Joi.string().valid('go', 'no_go', 'undecided').allow(null),
  decisionNote: Joi.string().trim().max(2000).allow(null, ''),
})
  .min(1)
  .required();

export const trackedTenderQuerySchema = Joi.object({
  filter: Joi.object({
    status: Joi.alternatives(
      Joi.array().items(Joi.string().valid(...STATUSES)),
      Joi.string().valid(...STATUSES)
    ),
  }).default({}),
  page: Joi.object({
    // Capped, like every other collection: an uncapped size lets one request
    // scan the whole board and is the cheapest possible denial of service.
    size: Joi.number().integer().min(1).max(100).default(20),
    cursor: Joi.string().max(200).allow(null, ''),
  }).default({}),
}).options({ stripUnknown: true });

/**
 * A draft bid.
 *
 * `price` is optional so a pursuit can be opened with notes before a number
 * exists — but submitting without one is refused in the service, because a
 * locked snapshot with no price records nothing.
 *
 * The upper bound is not decoration. The source publishes real bids like
 * 6,666,600,000,000 AMD against a 75,000 budget; a typo of that shape entered
 * by a customer would sail into their own win-rate maths and wreck it.
 */
export const saveBidSchema = Joi.object({
  price: Joi.number().min(0).max(1e13).allow(null),
  lotNumber: Joi.number().integer().min(1).allow(null),
  currency: Joi.string().trim().uppercase().length(3).default('AMD'),
  notes: Joi.string().trim().max(5000).allow(null, ''),
})
  .min(1)
  .required();

/**
 * `submittedAt` is accepted so a bid entered after the fact carries its real
 * date — backdating is the normal case for a customer onboarding with history,
 * and a future date is the one thing that cannot be true.
 */
export const submitBidSchema = Joi.object({
  submittedAt: Joi.date().iso().max('now'),
}).default({});

const CATEGORIES = ['eligibility', 'financial', 'technical', 'document', 'procedural'];

/**
 * `force` re-runs an extraction the worker would otherwise skip as unchanged.
 *
 * It exists for the case the document hash cannot detect: the PROMPT changed.
 * The hash covers the input, not the extractor, so without this an improved
 * prompt could never be applied to a tender already processed.
 */
export const generateChecklistSchema = Joi.object({
  force: Joi.boolean().default(false),
}).default({});

/**
 * A human-authored item. No `confidence` and no `evidence` field is accepted:
 * those describe a model's reading of a document, and letting a client set them
 * would make an assertion indistinguishable from an extraction.
 */
export const addChecklistItemSchema = Joi.object({
  label: Joi.string().trim().min(3).max(500).required(),
  category: Joi.string().valid(...CATEGORIES).allow(null),
  required: Joi.boolean().default(true),
}).required();

export const updateChecklistItemSchema = Joi.object({
  done: Joi.boolean(),
  required: Joi.boolean(),
  label: Joi.string().trim().min(3).max(500),
  // Clearing the flag is a human saying "I checked this". Setting it back to
  // true is allowed too — a second reviewer may disagree.
  needsReview: Joi.boolean(),
})
  .min(1)
  .required();

/** One more party this organization bids as. Unclaiming is `DELETE …/:partyId`. */
export const supplierClaimSchema = Joi.object({
  partyId: Joi.string().trim().max(40).required(),
}).required();

export const supplierClaimParamsSchema = Joi.object({
  partyId: Joi.string().trim().max(40).required(),
});

export const supplierSearchSchema = Joi.object({
  q: Joi.string().trim().min(2).max(200).required(),
}).options({ stripUnknown: true });

export default {
  generateChecklistSchema,
  addChecklistItemSchema,
  updateChecklistItemSchema,
  trackTenderSchema,
  updateTrackedTenderSchema,
  trackedTenderQuerySchema,
  saveBidSchema,
  submitBidSchema,
  supplierClaimSchema,
  supplierClaimParamsSchema,
  supplierSearchSchema,
};
