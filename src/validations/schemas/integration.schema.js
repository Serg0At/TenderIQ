import Joi from 'joi';

/**
 * Quiet hours (BR-10).
 *
 * Hours are local wall-clock, 0–23, treated as [start, end). `end` may be less
 * than `start` — a window that wraps midnight (22 → 8) is the setting most
 * people actually want, so it must not be rejected as backwards.
 *
 * Both null together clears the window. Requiring them to travel as a pair
 * stops a half-set window that would silently never trigger.
 */
export const quietHoursSchema = Joi.object({
  start: Joi.number().integer().min(0).max(23).allow(null).required(),
  end: Joi.number().integer().min(0).max(23).allow(null).required(),
  timezone: Joi.string().trim().max(64).default('Asia/Yerevan'),
})
  .custom((value, helpers) => {
    const cleared = value.start === null && value.end === null;
    const set = value.start !== null && value.end !== null;
    if (!cleared && !set) {
      return helpers.message('start and end must both be set, or both be null to clear');
    }
    return value;
  })
  .options({ stripUnknown: true });

/**
 * An inbound Telegram update.
 *
 * CLAUDE.md requires validation at every boundary, not just the authenticated
 * ones — and this is the least trusted input in the system: an unauthenticated
 * POST body from the public internet. Optional chaining in the handler is
 * defensive coding, not a schema.
 *
 * `stripUnknown` is the real work. Telegram's update object carries dozens of
 * fields this bot has no use for, and whitelisting to the four it reads means a
 * new upstream field can never reach the handler and can never be mistaken for
 * one of ours.
 *
 * Deliberately permissive about WHICH keys are present: Telegram sends exactly
 * one of `message` / `my_chat_member` / a dozen others per update, so requiring
 * either would reject the routine ones the handler correctly ignores. It
 * validates SHAPE, and the handler decides relevance.
 *
 * `chat.id` is a number in the Bot API but is stored and compared as a string,
 * so it is accepted as either and coerced by Joi's `convert`.
 */
export const telegramUpdateSchema = Joi.object({
  update_id: Joi.number().integer(),
  message: Joi.object({
    chat: Joi.object({ id: Joi.alternatives(Joi.number(), Joi.string()).required() }).required(),
    // Length-capped: the handler only ever reads a command prefix and a link
    // token, and an unbounded string is free memory for anyone who finds the URL.
    text: Joi.string().max(4096).allow(''),
  }),
  my_chat_member: Joi.object({
    chat: Joi.object({ id: Joi.alternatives(Joi.number(), Joi.string()).required() }).required(),
    new_chat_member: Joi.object({ status: Joi.string().max(32) }),
  }),
}).options({ stripUnknown: true, convert: true });

export default { quietHoursSchema, telegramUpdateSchema };
