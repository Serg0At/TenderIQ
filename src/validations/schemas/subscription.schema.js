import Joi from 'joi';

/**
 * `code` is only bounded, never pattern-checked: what a code may look like is
 * the operator's rule (operator.schema.js), and refusing a malformed one here
 * with its own message would be one more answer than `code_invalid`. The
 * service trims and upper-cases it.
 *
 * `trial` is optional at the boundary because only the service knows whether a
 * trial is running; it refuses a missing choice then, naming this field.
 */
export const redeemSchema = Joi.object({
  code: Joi.string().trim().min(1).max(100).required(),
  trial: Joi.string().valid('keep', 'end'),
}).required();

export default { redeemSchema };
