import Joi from 'joi';

/**
 * Latin letters, digits, `-` and `_`, after trimming and upper-casing.
 *
 * A code is typed by hand off a message or a flyer, and Armenian and Cyrillic
 * both have letters that look like Latin ones (Cyrillic А, Е, О, Р, С): a code
 * holding one would look right on paper and never match what an owner types.
 * Keeping to ASCII also keeps JavaScript's upper-casing and Postgres's
 * `upper()` in agreement, which the `promo_codes_code_chk` CHECK relies on.
 */
const CODE = /^[A-Z0-9][A-Z0-9_-]*$/;

export const createPromoCodeSchema = Joi.object({
  code: Joi.string().trim().uppercase().min(3).max(40).pattern(CODE).required().messages({
    'string.pattern.base': 'A code is Latin letters, digits, "-" and "_", starting with a letter or digit.',
  }),
  // A name from the plans table; an unknown one is refused by the service.
  plan: Joi.string().trim().lowercase().max(50).invalid('free').required().messages({
    'any.invalid': 'A promo code cannot grant the free plan.',
  }),
  percentOff: Joi.number().integer().min(1).max(100).required(),
  durationMonths: Joi.number().integer().min(1).max(120).required(),
  // null is unlimited — the shared launch code.
  maxRedemptions: Joi.number().integer().min(1).max(1_000_000).allow(null).default(null),
  // null never expires — a personal code waits for its person.
  redeemableUntil: Joi.date().iso().greater('now').allow(null).default(null),
}).required();

export const promoCodeQuerySchema = Joi.object({
  page: Joi.object({
    size: Joi.number().integer().min(1).max(100).default(20),
    cursor: Joi.string().max(200).allow(null, ''),
  }).default({}),
}).options({ stripUnknown: true });

export default { createPromoCodeSchema, promoCodeQuerySchema };
