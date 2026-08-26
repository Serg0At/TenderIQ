import Anthropic from '@anthropic-ai/sdk';
import config from '../../../configs/variables.config.js';
import { ApiError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';

const { AI } = config;

/**
 * The Anthropic adapter — the only file in the codebase that imports the SDK.
 *
 * Same rule as the storage port and every source parser: a third party lives
 * behind one module, so swapping it, stubbing it in a test, or reacting to an
 * API change is a change to one file rather than a search across the codebase.
 *
 * The client is built lazily, not at import time, so a deployment with no API
 * key still boots the API and the workers — only the one feature that needs it
 * degrades.
 */

let client = null;

const getClient = () => {
  if (!AI.API_KEY) {
    throw new ApiError('DEPENDENCY_UNAVAILABLE', {
      message: 'AI features are not configured.',
    });
  }
  if (!client) {
    client = new Anthropic({ apiKey: AI.API_KEY, timeout: AI.TIMEOUT_MS });
  }
  return client;
};

/** Whether the AI layer can be called at all — lets a caller degrade early. */
export const isConfigured = () => Boolean(AI.API_KEY);

/**
 * One schema-constrained completion.
 *
 * Three things here are structural rather than incidental:
 *
 * 1. **The system prompt is a stable cached prefix.** Nothing volatile — no
 *    timestamp, no tender id, no request id — may be interpolated into it, or
 *    the cache silently never hits and the cost is real. The volatile evidence
 *    goes in the user turn, after the breakpoint. Verified through
 *    `cache_read_input_tokens` on the returned usage.
 *
 * 2. **The output is schema-constrained**, so the reply is JSON of a known
 *    shape rather than prose to be regex'd. The caller still validates it —
 *    a constrained shape is not the same as a correct value.
 *
 * 3. **`stop_reason` is checked before the content is read.** A refusal is a
 *    200 with no usable content; reading `content[0]` first would throw a
 *    TypeError and report a model policy decision as a server bug.
 *
 * @param {object} opts
 * @param {string} opts.system       stable, cacheable system prefix
 * @param {string} opts.userContent  the volatile turn
 * @param {object} opts.schema       JSON Schema the reply must satisfy
 */
export const completeStructured = async ({ system, userContent, schema, model = AI.MODEL }) => {
  const anthropic = getClient();

  let response;
  try {
    response = await anthropic.messages.create({
      model,
      max_tokens: AI.MAX_TOKENS,
      // Adaptive thinking: the model decides how much reasoning a given tender
      // needs. Pricing against a thin comparable set is genuinely harder than
      // against a dense one, and a fixed budget would over-spend on the easy
      // case and under-think the hard one.
      thinking: { type: 'adaptive' },
      system: [
        {
          type: 'text',
          text: system,
          // The breakpoint. Everything before it is identical on every request
          // and is served from cache; the evidence below it is not.
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userContent }],
      output_config: { format: { type: 'json_schema', schema } },
    });
  } catch (error) {
    // Typed SDK classes, not string matching on the message.
    if (error instanceof Anthropic.RateLimitError) {
      throw new ApiError('RATE_LIMITED', { message: 'The AI service is rate limited.' });
    }
    if (error instanceof Anthropic.AuthenticationError) {
      logger.error('[ai] authentication rejected — check ANTHROPIC_API_KEY');
      throw new ApiError('DEPENDENCY_UNAVAILABLE', {
        message: 'AI features are not configured.',
      });
    }
    if (error instanceof Anthropic.APIError) {
      logger.error(`[ai] api error ${error.status}: ${error.message}`);
      throw new ApiError('DEPENDENCY_UNAVAILABLE', {
        message: 'The AI service is unavailable.',
      });
    }
    throw error;
  }

  // Before content. A refusal returns 200 with a stop_details category and no
  // text block — degrade and flag, never crash.
  if (response.stop_reason === 'refusal') {
    logger.warn(
      `[ai] refused: ${response.stop_details?.category ?? 'unknown'} — ${
        response.stop_details?.explanation ?? ''
      }`
    );
    return { status: 'refused', category: response.stop_details?.category ?? null, usage: response.usage };
  }

  // A truncated reply is invalid JSON, so it must be caught here rather than
  // failing later as an unexplained parse error.
  if (response.stop_reason === 'max_tokens') {
    logger.warn('[ai] response hit max_tokens before completing');
    return { status: 'truncated', usage: response.usage };
  }

  const text = response.content.find((block) => block.type === 'text')?.text;
  if (!text) return { status: 'empty', usage: response.usage };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 'unparseable', usage: response.usage };
  }

  return { status: 'ok', data: parsed, usage: response.usage, model: response.model };
};

export default { isConfigured, completeStructured };
