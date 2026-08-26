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
  expiry: '⌛ Tender closing',
};

const headingFor = (type) => {
  const key = Object.keys(HEADINGS).find((k) => type === k || String(type ?? '').startsWith(`${k}-`));
  return key ? HEADINGS[key] : '🔔 Tender alert';
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
