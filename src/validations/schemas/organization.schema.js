import Joi from 'joi';

export const createOrganizationSchema = Joi.object({
  name: Joi.string().trim().min(2).max(200).required(),
  // Free text today (IT, construction, medical…); nothing branches on it.
  type: Joi.string().trim().max(100).allow(null),
}).required();

export const rosterQuerySchema = Joi.object({
  page: Joi.object({
    size: Joi.number().integer().min(1).max(100).default(20),
    cursor: Joi.string().max(200).allow(null, ''),
  }).default({}),
}).options({ stripUnknown: true });

export default { createOrganizationSchema, rosterQuerySchema };
