import Joi from 'joi';
import { PURCHASE_KIND_CODES } from '../../libs/purchaseKinds.js';
import { FIELD_IDS } from '../../libs/fields.js';
import { SUBMISSION_CHANNELS } from './tender.schema.js';

/**
 * Discovery filters, per FR-DISC-1.
 *
 * Nested `filter[...]` / `page[...]` bracket syntax matches the API standard so
 * one convention covers every collection endpoint.
 *
 * `page[size]` is capped: an uncapped size lets one request scan the whole
 * corpus and is the cheapest possible denial of service.
 */
export const tenderQuerySchema = Joi.object({
  filter: Joi.object({
    cpv: Joi.alternatives(
      Joi.array().items(Joi.string().trim().max(20)),
      Joi.string().trim().max(200)
    ).default([]),
    keyword: Joi.string().trim().max(200).allow(''),
    buyerId: Joi.string().trim().max(40),
    region: Joi.string().trim().max(100),
    procedure: Joi.string().valid('open', 'quotation', 'single_source', 'e_auction', 'restricted'),
    status: Joi.alternatives(
      Joi.array().items(Joi.string().valid('planned', 'active', 'amended', 'closed', 'awarded', 'cancelled')),
      Joi.string().valid('planned', 'active', 'amended', 'closed', 'awarded', 'cancelled')
    ),
    minValue: Joi.number().min(0),
    maxValue: Joi.number().min(0),
    deadlineAfter: Joi.date().iso(),
    deadlineBefore: Joi.date().iso(),
    // Validated against the codes, so a typo is a 422 rather than an empty
    // list that reads as "nothing of that kind exists".
    purchaseKind: Joi.alternatives(
      Joi.array().items(Joi.string().valid(...PURCHASE_KIND_CODES)),
      Joi.string().valid(...PURCHASE_KIND_CODES)
    ),
    // One or several submission channels; any of them matches. Unknown is a
    // 422 for the same reason as purchaseKind.
    submissionChannel: Joi.alternatives(
      Joi.array().items(Joi.string().valid(...SUBMISSION_CHANNELS)),
      Joi.string().valid(...SUBMISSION_CHANNELS)
    ),
    // A Field from GET /fields, or several (any of them matches). Unknown is a
    // 422 for the same reason as purchaseKind.
    field: Joi.alternatives(
      Joi.array().items(Joi.string().valid(...FIELD_IDS)),
      Joi.string().valid(...FIELD_IDS)
    ),
  }).default({}),
  page: Joi.object({
    size: Joi.number().integer().min(1).max(100).default(20),
    cursor: Joi.string().max(200).allow(null, ''),
  }).default({}),
}).options({ stripUnknown: true });

export default { tenderQuerySchema };
