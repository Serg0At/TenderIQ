import Joi from 'joi';
import { ASSIGNABLE_ROLES } from '../../libs/permissions.js';

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

/**
 * A role change names one of the four non-owner roles. `owner` is a validation
 * failure that names the transfer endpoint: ownership is a hand-off, not an
 * assignment, and refusing it here says so structurally rather than leaving it
 * to a check that could be reordered away.
 */
export const changeRoleSchema = Joi.object({
  role: Joi.string()
    .invalid('owner')
    .valid(...ASSIGNABLE_ROLES)
    .required()
    .messages({
      'any.invalid':
        'Ownership cannot be assigned by a role change. Use POST /organization/transfer-ownership.',
    }),
}).required();

/** The member receiving the seat, by user id — never an address, never an invitation. */
export const transferOwnershipSchema = Joi.object({
  userId: Joi.string().trim().min(1).max(64).required(),
}).required();

/**
 * The organization's name, typed back. Compared exactly and deliberately not
 * trimmed or case-folded: the point is a deliberate act, not a fuzzy match.
 */
export const deleteOrganizationSchema = Joi.object({
  name: Joi.string().max(200).required(),
}).required();

export default {
  deleteOrganizationSchema,
  createOrganizationSchema,
  rosterQuerySchema,
  changeRoleSchema,
  transferOwnershipSchema,
};
