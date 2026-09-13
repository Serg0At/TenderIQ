import Joi from 'joi';
import { DELIVERABLE_CHANNELS } from '../../libs/adapters/channel/notification.present.js';

const codes = Joi.array().items(Joi.string().trim().max(20)).max(100);
const words = Joi.array().items(Joi.string().trim().min(2).max(100)).max(50);
const name = Joi.string().trim().min(1).max(100);

/**
 * At least one positive signal is required.
 *
 * A profile with no CPV codes and no keywords matches every tender ever
 * published, which is indistinguishable from spam to the person receiving it —
 * and alert noise is what kills trust in the whole feature.
 */
export const createSavedSearchSchema = Joi.object({
  name: name.required(),
  cpvCodes: codes.default([]),
  keywords: words.default([]),
  regions: Joi.array().items(Joi.string().trim().max(100)).max(20).default([]),
  minValue: Joi.number().min(0).allow(null),
  maxValue: Joi.number().min(0).allow(null),
  /**
   * Empty by default, and that default is the fix for a real outage.
   *
   * It used to be `['email']`, chosen when email was a stub that answered every
   * send with "not implemented" — so every saved search created through the API
   * named a channel the dispatcher could not deliver on, recorded a failed
   * `alert_deliveries` row per match, and reached nobody. The org's linked
   * Telegram chat was never consulted, because the fallback only fires when this
   * array is empty.
   *
   * `[]` means "however this organization can actually be reached", resolved at
   * send time by `channelsForOrg`. That is the honest default: it names no
   * channel the customer has not configured, and it starts working the moment
   * they link one instead of needing this row edited too.
   *
   * The valid set is `DELIVERABLE_CHANNELS`, so it is impossible to select a
   * channel that has no transport — which is the shape of the bug above.
   */
  channels: Joi.array()
    .items(Joi.string().valid(...DELIVERABLE_CHANNELS))
    .max(DELIVERABLE_CHANNELS.length)
    .unique()
    .default([]),
})
  .or('cpvCodes', 'keywords')
  .custom((value, helpers) => {
    if (!value.cpvCodes?.length && !value.keywords?.length) {
      return helpers.error('any.custom', { message: 'Provide at least one CPV code or keyword.' });
    }
    if (value.minValue !== null && value.maxValue !== null && value.minValue > value.maxValue) {
      return helpers.error('any.custom', { message: 'minValue cannot exceed maxValue.' });
    }
    return value;
  })
  .required();

export const updateSavedSearchSchema = Joi.object({
  name,
  cpvCodes: codes,
  keywords: words,
  regions: Joi.array().items(Joi.string().trim().max(100)).max(20),
  minValue: Joi.number().min(0).allow(null),
  maxValue: Joi.number().min(0).allow(null),
  channels: Joi.array()
    .items(Joi.string().valid(...DELIVERABLE_CHANNELS))
    .max(DELIVERABLE_CHANNELS.length)
    .unique(),
})
  .min(1)
  .required();

export default { createSavedSearchSchema, updateSavedSearchSchema };
