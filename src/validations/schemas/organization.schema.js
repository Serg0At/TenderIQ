import Joi from 'joi';

export const createOrganizationSchema = Joi.object({
  name: Joi.string().trim().min(2).max(200).required(),
  // Free text today (IT, construction, medical…); nothing branches on it.
  type: Joi.string().trim().max(100).allow(null),
}).required();

export default { createOrganizationSchema };
