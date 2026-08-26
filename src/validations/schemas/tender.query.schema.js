import Joi from 'joi';

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
  }).default({}),
  page: Joi.object({
    size: Joi.number().integer().min(1).max(100).default(20),
    cursor: Joi.string().max(200).allow(null, ''),
  }).default({}),
}).options({ stripUnknown: true });

export default { tenderQuerySchema };
