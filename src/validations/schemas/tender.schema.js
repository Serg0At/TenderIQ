import Joi from 'joi';

// Normalized listing data is intentionally smaller than the eventual detail
// model: ARMEPS listing pages do not expose buyer, CPV, or value information.
export const normalizedTenderSchema = Joi.object({
  sourceId: Joi.string().trim().min(1).required(),
  title: Joi.string().trim().min(1).required(),
  buyerId: Joi.string().trim().min(1).required(),
  procedureType: Joi.string().trim().min(1).required(),
  status: Joi.string().trim().min(1).required(),
  currency: Joi.string().length(3).required(),
  cpvCode: Joi.string().trim().allow(null),
  estimatedValue: Joi.number().precision(2).allow(null),
  publishedAt: Joi.date().allow(null),
  deadlineAt: Joi.date().allow(null),
  qnaDeadlineAt: Joi.date().allow(null),
}).required();

export default normalizedTenderSchema;
