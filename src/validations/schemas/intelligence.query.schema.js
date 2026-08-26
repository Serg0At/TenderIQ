import Joi from 'joi';

/**
 * Query schemas for the intelligence endpoints.
 *
 * Same `filter[...]` bracket convention as discovery, so one client-side
 * convention covers every collection-shaped endpoint. `stripUnknown` is what
 * makes these worth having: the validated value replaces `req.query`, so an
 * undeclared parameter cannot ride through into a repository.
 */

export const competitorPricesQuerySchema = Joi.object({
  filter: Joi.object({
    /** Narrow to a single lot of the tender. */
    lot: Joi.number().integer().min(1),
    /**
     * Rejected bids are included by default and labelled `rejected`, never
     * silently dropped: a supplier comparing itself against a headline price is
     * entitled to know that price was disqualified. The flag exists so a client
     * can offer a "accepted bids only" view, not so the default can hide them.
     */
    includeRejected: Joi.boolean().default(true),
  }).default({}),
}).options({ stripUnknown: true });

export const expectedCompetitionQuerySchema = Joi.object({
  filter: Joi.object({
    cpv: Joi.string().trim().max(20),
    buyerId: Joi.string().trim().max(40),
    sinceMonths: Joi.number().integer().min(1).max(120),
  }).default({}),
}).options({ stripUnknown: true });

export default {
  competitorPricesQuerySchema,
  expectedCompetitionQuerySchema,
};
