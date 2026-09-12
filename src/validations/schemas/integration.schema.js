import Joi from 'joi';

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
 *
 * **`chat.type` MUST be declared here**, and its absence would be a silent
 * production-only bug. Linking is personal-chat-only, and that check fails
 * closed — anything that is not explicitly `private` is refused. The polling
 * worker hands `handleUpdate` the raw update, so it sees the field; the webhook
 * hands it a `stripUnknown` copy, which would drop an undeclared `type` and make
 * every link attempt fail with "personal chats only". Polling is the dev
 * default and the webhook is the production path, so the failure would appear
 * only after deployment.
 */
export const telegramUpdateSchema = Joi.object({
  update_id: Joi.number().integer(),
  message: Joi.object({
    chat: Joi.object({
      id: Joi.alternatives(Joi.number(), Joi.string()).required(),
      // private | group | supergroup | channel. Only `private` may be linked.
      type: Joi.string().max(32),
    }).required(),
    // Length-capped: the handler only ever reads a command prefix and a link
    // token, and an unbounded string is free memory for anyone who finds the URL.
    text: Joi.string().max(4096).allow(''),
  }),
  my_chat_member: Joi.object({
    chat: Joi.object({ id: Joi.alternatives(Joi.number(), Joi.string()).required() }).required(),
    new_chat_member: Joi.object({ status: Joi.string().max(32) }),
  }),
}).options({ stripUnknown: true, convert: true });

export default { telegramUpdateSchema };
