import Joi from 'joi';
import { ASSIGNABLE_ROLES } from '../../libs/permissions.js';
import { FIELD_IDS, MAX_FIELDS } from '../../libs/fields.js';

/**
 * An organization's Fields: ids from the fixed list, at most three, no repeats.
 * A value off the list or a fourth entry is a 422 — the column holds ids the
 * filter and the ranking can resolve, never free text.
 */
const fields = Joi.array().items(Joi.string().valid(...FIELD_IDS)).max(MAX_FIELDS).unique();

export const createOrganizationSchema = Joi.object({
  name: Joi.string().trim().min(2).max(200).required(),
  // Optional, so founding an organization stays one screen.
  fields: fields.default([]),
}).required();

/**
 * Changing the organization's settings. Fields only today; `.min(1)` so an
 * empty body is a 422 rather than a write that changes nothing.
 */
export const updateOrganizationSchema = Joi.object({
  fields,
})
  .min(1)
  .required();

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
  updateOrganizationSchema,
  rosterQuerySchema,
  changeRoleSchema,
  transferOwnershipSchema,
};
