import Joi from 'joi';

/**
 * Minimum length only, no composition rules.
 *
 * Forced symbol/digit mixes push people toward predictable substitutions and
 * password reuse; length is the property that actually resists guessing.
 */
const password = Joi.string().min(12).max(200).required();

/** The login identity, normalised here so the repository's lower() always matches. */
const email = Joi.string().email().lowercase().max(255).required();

const locale = Joi.string().valid('hy', 'ru', 'en').default('hy');

const organizationName = Joi.string().trim().min(2).max(200).required();

/**
 * What a colleague is called on the roster.
 *
 * Required, because the roster's whole point is that a team can see who is on
 * it; optional here means the member list degrades to email addresses for
 * whoever skipped the field.
 */
const displayName = Joi.string().trim().min(1).max(120).required();

export const registerSchema = Joi.object({
  email,
  password,
  displayName,
  organizationName,
  locale,
}).required();

export const loginSchema = Joi.object({
  email,
  password: Joi.string().max(200).required(),
}).required();

/**
 * An organization id is an opaque CUID. Bounded so junk is refused at the
 * boundary instead of becoming a membership lookup.
 */
export const switchOrgSchema = Joi.object({
  organizationId: Joi.string().trim().min(1).max(64).required(),
}).required();

export const refreshSchema = Joi.object({
  refreshToken: Joi.string().min(20).required(),
}).required();

/**
 * The token is 32 random bytes in base64url — 43 characters. Bounded on both
 * sides so a megabyte of junk is rejected at the boundary rather than becoming
 * a Redis key lookup.
 */
export const verifyEmailSchema = Joi.object({
  token: Joi.string().trim().min(20).max(200).required(),
}).required();

export const resendVerificationSchema = Joi.object({ email }).required();

export const forgotPasswordSchema = Joi.object({ email }).required();

/** Exactly six digits. A code of any other shape cannot be one we issued. */
const resetCode = Joi.string()
  .pattern(/^\d{6}$/)
  .required()
  .messages({ 'string.pattern.base': 'The code is six digits.' });

export const verifyResetCodeSchema = Joi.object({
  email,
  code: resetCode,
}).required();

export const resetPasswordSchema = Joi.object({
  email,
  code: resetCode,
  newPassword: password,
}).required();

export default {
  registerSchema,
  loginSchema,
  refreshSchema,
  switchOrgSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  forgotPasswordSchema,
  verifyResetCodeSchema,
  resetPasswordSchema,
};
