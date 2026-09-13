import Joi from 'joi';
import { ROLES } from '../../libs/permissions.js';

/**
 * The roles an invitation may offer: every role except owner.
 *
 * Owner is refused with its own message rather than folded into "must be one
 * of", because the refusal is structural — there is one owner seat and it moves
 * by transfer — and a client should be able to say so.
 */
export const INVITABLE_ROLES = ROLES.filter((role) => role !== 'owner');

const role = Joi.string()
  .invalid('owner')
  .valid(...INVITABLE_ROLES)
  .required()
  .messages({
    'any.invalid':
      'Ownership cannot be offered by invitation. Invite them at another role, then use POST /organization/transfer-ownership.',
  });

export const sendInvitationSchema = Joi.object({
  email: Joi.string().trim().email().lowercase().max(255).required(),
  role,
}).required();

export const invitationQuerySchema = Joi.object({
  filter: Joi.object({
    status: Joi.string().valid('pending', 'accepted', 'declined'),
  }).default({}),
  page: Joi.object({
    size: Joi.number().integer().min(1).max(100).default(20),
    cursor: Joi.string().max(200).allow(null, ''),
  }).default({}),
}).options({ stripUnknown: true });

export const myInvitationQuerySchema = Joi.object({
  page: Joi.object({
    size: Joi.number().integer().min(1).max(100).default(20),
    cursor: Joi.string().max(200).allow(null, ''),
  }).default({}),
}).options({ stripUnknown: true });

export default {
  INVITABLE_ROLES,
  sendInvitationSchema,
  invitationQuerySchema,
  myInvitationQuerySchema,
};
