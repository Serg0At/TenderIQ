import { escapeHtml } from '../../../utils/html.js';
import {
  money,
  deadline,
  tenderLink,
  appLink,
  headingFor,
  isVaultType,
} from './notification.present.js';

/**
 * Alert text for Telegram. Pure — no I/O, no clock, no database.
 *
 * Kept apart from the transport so the wording can be read and changed without
 * touching the API client. What a notification *says* — the heading, the money,
 * the deadline, the link — is shared with the email channel in
 * `notification.present.js`; what is left here is the part that is genuinely
 * Telegram's: its markup, and the shape of a chat message.
 *
 * The transport uses `parse_mode: HTML` rather than MarkdownV2, and that is why
 * `escapeHtml` is enough. MarkdownV2 requires escaping eighteen characters
 * wherever they appear, including `.`, `-`, `(` and `!`. Armenian procurement
 * titles are full of parentheses, hyphens and decimal numbers, so a MarkdownV2
 * alert is a 400 waiting to happen — and a dropped alert is the one failure
 * this product cannot have.
 */

/** `🎯 New matching tender` — Telegram renders both halves; a chat message is skimmed by its emoji. */
const heading = (type) => {
  const { emoji, label } = headingFor(type);
  return `${emoji} ${label}`;
};

/**
 * A vault expiry alert.
 *
 * Says what to do, not just what happened: an expired tax clearance is only
 * actionable if the message names the document. The `kind` is the slug the
 * customer chose, printed as-is rather than mapped through a display table that
 * would have nothing to say about a kind they invented.
 */
const formatVaultNotification = (notification, payload, lines, now) => {
  const label = payload.filename || payload.kind;
  if (label) lines.push(escapeHtml(label));

  const facts = [];
  if (payload.kind && payload.filename) facts.push(`🏷 ${escapeHtml(payload.kind)}`);

  if (payload.validUntil) {
    const at = new Date(payload.validUntil);
    if (!Number.isNaN(at.getTime())) {
      const iso = at.toISOString().slice(0, 10);
      const days = Math.ceil((at.getTime() - now.getTime()) / 86_400_000);
      facts.push(days <= 0 ? `⛔ Expired ${escapeHtml(iso)}` : `🗓 Valid until ${escapeHtml(iso)}`);
    }
  }

  if (payload.daysRemaining > 0) {
    facts.push(`⏳ ${escapeHtml(`${payload.daysRemaining} day(s) left`)}`);
  }

  if (facts.length) lines.push('', ...facts);

  lines.push(
    '',
    notification.type === 'vault-expired'
      ? '<i>This document can no longer be attached to a bid.</i>'
      : '<i>Renew it before it lapses — an expired document cannot be attached to a bid.</i>'
  );

  // Only when the product exists to link to. There is no source page to fall
  // back on here: this is the customer's own file, not a scraped one.
  const url = payload.documentId ? appLink(`/vault-documents/${payload.documentId}`) : null;
  if (url) lines.push('', `<a href="${escapeHtml(url)}">Open document</a>`);

  return lines.join('\n');
};

/**
 * One notification as Telegram HTML.
 *
 * Built from `notification.payload` alone so the formatter needs no database
 * access. Every field is optional: notifications raised before a payload field
 * existed must still render, so a missing value drops its line rather than
 * printing "undefined".
 */
export const formatNotification = (notification, { now = new Date() } = {}) => {
  const payload = notification.payload ?? {};
  const lines = [`<b>${escapeHtml(heading(notification.type))}</b>`];

  /**
   * Vault alerts are about a document, not a tender, and share none of the
   * tender fields below — no buyer, no reference code, no estimated value. Run
   * through the tender renderer they would print a heading and nothing else,
   * since every line drops when its field is missing.
   */
  if (isVaultType(notification.type)) {
    return formatVaultNotification(notification, payload, lines, now);
  }

  if (payload.title) lines.push(escapeHtml(payload.title));

  const facts = [];
  if (payload.buyerName) facts.push(`🏛 ${escapeHtml(payload.buyerName)}`);
  if (payload.referenceCode) facts.push(`🔖 <code>${escapeHtml(payload.referenceCode)}</code>`);

  const value = money(payload.estimatedValue, payload.currency ?? 'AMD');
  if (value) facts.push(`💰 ${escapeHtml(value)}`);

  const due = deadline(payload.deadlineAt, now);
  if (due) facts.push(`🗓 ${escapeHtml(due)}`);
  // The reminder worker computes this against the threshold it fired at, which
  // is more precise than re-deriving it from the deadline at send time.
  if (payload.hoursRemaining) facts.push(`⏳ ${escapeHtml(`${payload.hoursRemaining}h remaining`)}`);

  // The pipeline stage, on countdowns only. "still considering" three hours out
  // is a different message from "preparing", and it is the whole reason this
  // alert is separate from the matched reminder. Must be pushed BEFORE `facts`
  // is spread into `lines` — after it, the array is already copied.
  if (payload.pipelineStatus) facts.push(`📋 ${escapeHtml(payload.pipelineStatus)}`);

  if (facts.length) lines.push('', ...facts);

  // Amendments carry what moved — a re-notification with no "what changed" is
  // indistinguishable from a duplicate, which is how people learn to ignore.
  if (notification.type === 'amendment' && payload.changedFields?.length) {
    lines.push('', `<b>Changed:</b> ${escapeHtml(payload.changedFields.join(', '))}`);
  }

  // Why this matched, so a noisy profile can be recognised and narrowed.
  if (payload.reasons?.length) {
    lines.push('', `<i>${escapeHtml(payload.reasons.slice(0, 3).join(' · '))}</i>`);
  }

  const link = tenderLink(payload, notification.tender_id);
  // The URL goes in an href attribute, where a raw quote or angle bracket would
  // break out of the tag — so it is escaped like any other untrusted value.
  if (link) lines.push('', `<a href="${escapeHtml(link)}">Open tender</a>`);

  return lines.join('\n');
};

/** Sent to the chat once a link is confirmed, so the user sees it worked. */
export const linkConfirmation = (organizationName) =>
  [
    '<b>✅ Alerts connected</b>',
    '',
    `This chat will now receive tender alerts for ${escapeHtml(organizationName)}.`,
    '',
    'Send /stop at any time to disconnect.',
  ].join('\n');

export const linkRejected = (reason) =>
  [`<b>⚠️ Could not connect</b>`, '', escapeHtml(reason)].join('\n');

export const stopConfirmation = () =>
  [
    '<b>Disconnected</b>',
    '',
    'This chat will no longer receive tender alerts.',
    'Use the connect link in TenderIQ to reconnect.',
  ].join('\n');

// `escapeHtml` and `tenderLink` are deliberately not re-exported: they moved to
// `utils/html.js` and `notification.present.js`, and a second name for them here
// is how the email channel would end up importing Telegram's copy.
export default {
  formatNotification,
  linkConfirmation,
  linkRejected,
  stopConfirmation,
};
