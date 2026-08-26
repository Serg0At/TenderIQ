import Joi from 'joi';

/**
 * Minimum length only, no composition rules.
 *
 * Forced symbol/digit mixes push people toward predictable substitutions and
 * password reuse; length is the property that actually resists guessing.
 */
const password = Joi.string().min(12).max(200).required();

export const registerSchema = Joi.object({
  email: Joi.string().email().lowercase().max(255).required(),
  password,
  organizationName: Joi.string().trim().min(2).max(200).required(),
  locale: Joi.string().valid('hy', 'ru', 'en').default('hy'),
}).required();

export const loginSchema = Joi.object({
  email: Joi.string().email().lowercase().max(255).required(),
  password: Joi.string().max(200).required(),
}).required();

export const refreshSchema = Joi.object({
  refreshToken: Joi.string().min(20).required(),
}).required();

export default { registerSchema, loginSchema, refreshSchema };
