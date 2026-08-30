import config from '../../../configs/variables.config.js';

const { APP } = config;

/**
 * Alert text for Telegram. Pure — no I/O, no clock, no database.
 *
 * Kept apart from the transport so the wording can be read and changed without
 * touching the API client, and so the escaping rule lives in exactly one place.
 */

/**
 * Escape for `parse_mode: HTML`.
 *
 * Telegram's HTML mode needs exactly three characters escaped, and `&` must go
 * first or it would double-escape the entities produced by the other two.
 *
 * This is the whole reason the transport uses HTML rather than MarkdownV2:
 * MarkdownV2 requires escaping eighteen characters wherever they appear,
 * including `.`, `-`, `(` and `!`. Armenian procurement titles are full of
 * parentheses, hyphens and decimal numbers, so a MarkdownV2 alert is a 400
 * waiting to happen — and a dropped alert is the one failure this product
 * cannot have.
 *
 * Scraped source text reaches this function directly, so treating it as data
 * rather than markup is a safety property, not a formatting preference.
 */
export const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Telegram's text mode does not require this one, but the same helper is
    // used inside href="…" where an unescaped quote closes the attribute early
    // and lets scraped text inject its own. Escaping it always is cheaper than
    // remembering which call site is an attribute.
    .replace(/"/g, '&quot;');

/** AMD with thousands separators. Armenian procurement values run to billions. */
const money = (amount, currency = 'AMD') => {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${currency}`;
};

/** Absolute date plus a relative hint, because "in 3 days" is what gets acted on. */
const deadline = (value, now = new Date()) => {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;

  const iso = at.toISOString().slice(0, 16).replace('T', ' ');
  const hours = Math.round((at.getTime() - now.getTime()) / 3_600_000);

  if (hours < 0) return `${iso} UTC (passed)`;
  if (hours < 48) return `${iso} UTC (in ${hours}h)`;
  return `${iso} UTC (in ${Math.round(hours / 24)}d)`;
};

/**
 * Where the alert points.
 *
 * Prefers the product, falls back to the source's own page. While there is no
 * frontend, `APP_BASE_URL` is unset and the link goes to the procurement site —
 * which is where the supplier has to end up anyway to bid. A link into an app
 * that does not exist would be worse than none.
 */
export const tenderLink = (payload = {}, tenderId = null) => {
  if (APP.BASE_URL && tenderId) return `${APP.BASE_URL.replace(/\/+$/, '')}/tenders/${tenderId}`;

  const candidate = payload.sourceUrl ?? payload.invitationUrl ?? null;
  if (!candidate) return null;

  /**
   * Scheme allow-list. The URL originates in scraped HTML, so it is untrusted:
   * a `javascript:` or `data:` href has no business in an outbound alert.
   * Telegram sanitises links its own way, but the boundary that knows this
   * value came from a crawled page is this one.
   */
  try {
    const { protocol } = new URL(candidate);
    return protocol === 'https:' || protocol === 'http:' ? candidate : null;
  } catch {
    // Not a URL at all — a relative path or parser noise. Drop the link rather
    // than emit an anchor that cannot resolve.
    return null;
  }
};

/**
 * Heading per notification type.
 *
 * Matched by prefix, not by exact key: the reminder worker emits `reminder-72h`
 * and `reminder-24h`, one type per threshold, so an exact lookup on `reminder`
 * silently fell through to the generic heading for every deadline reminder —
 * the alerts most likely to be acted on.
 */
const HEADINGS = {
  'tender-match': '🎯 New matching tender',
  amendment: '✏️ Tender amended',
  reminder: '⏰ Deadline approaching',
  // Distinct from `reminder` on purpose: a countdown fires only on a tender the
  // supplier said they are pursuing, so it deserves a heading that reads as
  // "your bid", not "a tender exists".
  countdown: '🚨 Bid deadline — you are pursuing this',
  expiry: '⌛ Tender closing',
  // Checked before `expiry` would ever be reached, and named in full: a vault
  // alert is about the company's own certificate, not about a tender closing,
  // and the two must not share a heading.
  'vault-expiry': '📄 Document expiring',
  'vault-expired': '⛔ Document expired',
};

/**
 * Longest key first, so a prefix match cannot be stolen by a shorter one.
 * `vault-expiry-30d` must not fall to `expiry`, and `vault-expired` must not
 * fall to `vault-expiry` — object key order is insertion order, which is a
 * fragile thing to depend on.
 */
const HEADING_KEYS = Object.keys(HEADINGS).sort((a, b) => b.length - a.length);

const headingFor = (type) => {
  const key = HEADING_KEYS.find((k) => type === k || String(type ?? '').startsWith(`${k}-`));
  return key ? HEADINGS[key] : '🔔 Tender alert';
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
  if (APP.BASE_URL && payload.documentId) {
    const url = `${APP.BASE_URL.replace(/\/+$/, '')}/vault-documents/${payload.documentId}`;
    lines.push('', `<a href="${escapeHtml(url)}">Open document</a>`);
  }

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
  const lines = [`<b>${escapeHtml(headingFor(notification.type))}</b>`];

  /**
   * Vault alerts are about a document, not a tender, and share none of the
   * tender fields below — no buyer, no reference code, no estimated value. Run
   * through the tender renderer they would print a heading and nothing else,
   * since every line drops when its field is missing.
   */
  if (String(notification.type ?? '').startsWith('vault-')) {
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

export default {
  escapeHtml,
  formatNotification,
  tenderLink,
  linkConfirmation,
  linkRejected,
  stopConfirmation,
};
