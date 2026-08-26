import Joi from 'joi';

const codes = Joi.array().items(Joi.string().trim().max(20)).max(100);
const words = Joi.array().items(Joi.string().trim().min(2).max(100)).max(50);

/**
 * At least one positive signal is required.
 *
 * A profile with no CPV codes and no keywords matches every tender ever
 * published, which is indistinguishable from spam to the person receiving it —
 * and alert noise is what kills trust in the whole feature.
 */
export const createSavedSearchSchema = Joi.object({
  cpvCodes: codes.default([]),
  keywords: words.default([]),
  regions: Joi.array().items(Joi.string().trim().max(100)).max(20).default([]),
  minValue: Joi.number().min(0).allow(null),
  maxValue: Joi.number().min(0).allow(null),
  channels: Joi.array().items(Joi.string().valid('email', 'telegram', 'viber')).max(3).default(['email']),
})
  .or('cpvCodes', 'keywords')
  .custom((value, helpers) => {
    if (!value.cpvCodes?.length && !value.keywords?.length) {
      return helpers.error('any.custom', { message: 'Provide at least one CPV code or keyword.' });
    }
    if (value.minValue !== null && value.maxValue !== null && value.minValue > value.maxValue) {
      return helpers.error('any.custom', { message: 'minValue cannot exceed maxValue.' });
    }
    return value;
  })
  .required();

export const updateSavedSearchSchema = Joi.object({
  cpvCodes: codes,
  keywords: words,
  regions: Joi.array().items(Joi.string().trim().max(100)).max(20),
  minValue: Joi.number().min(0).allow(null),
  maxValue: Joi.number().min(0).allow(null),
  channels: Joi.array().items(Joi.string().valid('email', 'telegram', 'viber')).max(3),
})
  .min(1)
  .required();

export default { createSavedSearchSchema, updateSavedSearchSchema };
