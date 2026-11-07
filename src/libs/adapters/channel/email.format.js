import { escapeHtml } from '../../../utils/html.js';
import { layout, paragraph } from '../email/email.format.js';
import {
  money,
  deadline,
  tenderLink,
  appLink,
  headingFor,
  isVaultType,
  isTeamType,
  teamAnnouncement,
  isSubscriptionType,
  subscriptionAnnouncement,
  matchedSearchesLine,
  changeLine,
  digestTitle,
} from './notification.present.js';

/**
 * One alert as an email. Pure — no I/O, no clock, no database.
 *
 * There is no `channel/email.js` beside this file, and that asymmetry with
 * Telegram is deliberate. Telegram needs its own transport because nothing else
 * in the system speaks the Bot API; mail already has a port at
 * `libs/adapters/email/`, built for verification and reset messages, and a
 * second SMTP client would be a second place to get STARTTLS wrong. So the
 * alert channel is a formatter plus a delivery policy, and the transport is
 * borrowed. What lives here is only what Telegram's formatter is: the markup
 * and the envelope. The facts are shared, in `notification.present.js`.
 *
 * Every message is built as text AND HTML. A text/plain-only message is the
 * shape spam filters like least, and a supplier reading alerts on a phone gets
 * the HTML while a mail-to-ticket bridge gets something readable.
 */

/**
 * Subject lines carry the words, never the emoji.
 *
 * The emoji is what makes a Telegram alert skimmable in a chat list, and it is
 * what makes an email look like marketing — leading emoji is a documented spam
 * signal, and it is the first thing a narrow client truncates, which would cost
 * the only part of the line that says what happened.
 */
const SUBJECT_MAX = 140;

const subjectFor = (notification, payload) => {
  const { label } = headingFor(notification.type);
  const subject =
    payload.title || payload.filename || payload.kind || payload.organizationName || null;
  if (!subject) return label;

  const full = `${label}: ${subject}`;
  // Truncated on a character count rather than left to the client, so the cut
  // is visible as an ellipsis instead of looking like the sentence ended.
  return full.length <= SUBJECT_MAX ? full : `${full.slice(0, SUBJECT_MAX - 1)}…`;
};

/** A label/value row. Inline-styled and table-free, matching the auth mail. */
const fact = (label, value) =>
  `<p style="margin:0 0 6px;font-size:14px;line-height:1.5"><span style="color:#6b7280">${escapeHtml(label)}</span> ${escapeHtml(value)}</p>`;

const button = (url, text) =>
  `<p style="margin:20px 0 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#1a56db;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px">${escapeHtml(text)}</a></p>`;

/**
 * Where a recipient goes to stop receiving this.
 *
 * Named in every alert, because the alternative to an obvious "turn this off"
 * link is the recipient pressing the spam button — which costs the sending
 * domain's reputation and takes every other customer's alerts down with it.
 */
const WHY = 'You are receiving this because tender alerts are switched on for your Tendra account.';

/**
 * The visible unsubscribe line, not just the header.
 *
 * The `List-Unsubscribe` header drives the button a mail client shows beside
 * the sender, and most people never notice it. The link in the footer is the
 * one someone actually finds when they have decided they want this to stop —
 * and the alternative to finding it is the spam button, which costs the sending
 * domain's reputation and takes every other customer's alerts down with it.
 *
 * `unsubscribeUrl` is per-recipient, so it arrives as an argument rather than
 * being read from config here: this module stays pure, and the token that
 * belongs to one subscription cannot leak into another's copy.
 */
const footer = (unsubscribeUrl) =>
  unsubscribeUrl
    ? `${WHY}\n\nStop these emails: ${unsubscribeUrl}`
    : `${WHY} Manage them in Tendra under Integrations.`;

const footerHtml = (unsubscribeUrl) => {
  const body = unsubscribeUrl
    ? `${escapeHtml(WHY)} <a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280">Stop these emails</a>.`
    : `${escapeHtml(WHY)} Manage them in Tendra under Integrations.`;
  return `<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">${body}</p>`;
};

/**
 * A vault alert is about the organization's own certificate, not about a
 * tender, and shares none of the tender fields — no buyer, no reference code,
 * no estimated value. Run through the tender renderer it would produce a
 * heading and an empty body, since every line drops when its field is missing.
 */
const vaultBody = (notification, payload, now) => {
  const facts = [];
  const lines = [];

  if (payload.kind && payload.filename) {
    facts.push(['Type', payload.kind]);
  }

  if (payload.validUntil) {
    const at = new Date(payload.validUntil);
    if (!Number.isNaN(at.getTime())) {
      const iso = at.toISOString().slice(0, 10);
      const days = Math.ceil((at.getTime() - now.getTime()) / 86_400_000);
      facts.push(days <= 0 ? ['Expired', iso] : ['Valid until', iso]);
    }
  }

  if (payload.daysRemaining > 0) facts.push(['Remaining', `${payload.daysRemaining} day(s)`]);

  const advice =
    notification.type === 'vault-expired'
      ? 'This document can no longer be attached to a bid.'
      : 'Renew it before it lapses — an expired document cannot be attached to a bid.';

  const label = payload.filename || payload.kind;
  if (label) lines.push(label);
  if (facts.length) lines.push('', ...facts.map(([k, v]) => `${k}: ${v}`));
  lines.push('', advice);

  // No source page to fall back on here: this is the customer's own file, not a
  // scraped one, so an unset APP_BASE_URL means no link rather than a wrong one.
  const url = payload.documentId ? appLink(`/vault-documents/${payload.documentId}`) : null;
  if (url) lines.push('', url);

  return {
    text: lines.join('\n'),
    html: [
      label ? paragraph(label) : '',
      ...facts.map(([k, v]) => fact(k, v)),
      paragraph(advice),
      url ? button(url, 'Open document') : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
};

/** A team announcement: one third-person sentence, and the roster to open. */
const teamBody = (notification, payload) => {
  const sentence = teamAnnouncement(notification.type, payload);
  const url = appLink('/organization/members');
  return {
    text: url ? `${sentence}\n\n${url}` : sentence,
    html: [paragraph(sentence), url ? button(url, 'Open team') : ''].filter(Boolean).join('\n'),
  };
};

/** A subscription announcement: the same shape, pointing at the subscription. */
const subscriptionBody = (notification, payload) => {
  const sentence = subscriptionAnnouncement(notification.type, payload);
  const url = appLink('/organization/subscription');
  return {
    text: url ? `${sentence}\n\n${url}` : sentence,
    html: [paragraph(sentence), url ? button(url, 'Open subscription') : ''].filter(Boolean).join('\n'),
  };
};

const tenderBody = (notification, payload, now) => {
  const facts = [];
  if (payload.buyerName) facts.push(['Buyer', payload.buyerName]);
  if (payload.referenceCode) facts.push(['Reference', payload.referenceCode]);

  const value = money(payload.estimatedValue, payload.currency ?? 'AMD');
  if (value) facts.push(['Estimated value', value]);

  const due = deadline(payload.deadlineAt, now);
  if (due) facts.push(['Deadline', due]);
  // Computed by the reminder worker against the threshold it fired at, which is
  // more precise than re-deriving it from the deadline at send time.
  if (payload.hoursRemaining) facts.push(['Remaining', `${payload.hoursRemaining}h`]);
  // The pipeline stage, on countdowns and on an amendment to a tracked tender.
  // "still considering" three hours out is a different message from "preparing".
  if (payload.pipelineStatus) facts.push(['Your pipeline status', payload.pipelineStatus]);

  const lines = [];
  const html = [];

  if (payload.title) {
    lines.push(payload.title);
    html.push(
      `<p style="margin:0 0 16px;font-size:16px;font-weight:600;line-height:1.4">${escapeHtml(payload.title)}</p>`
    );
  }

  if (facts.length) {
    lines.push('', ...facts.map(([k, v]) => `${k}: ${v}`));
    html.push(...facts.map(([k, v]) => fact(k, v)));
  }

  // An amendment with no "what changed" is indistinguishable from a duplicate,
  // which is how people learn to ignore the whole stream.
  const changed = notification.type === 'amendment' ? changeLine(payload) : null;
  if (changed) {
    lines.push('', `Changed: ${changed}`);
    html.push(
      `<p style="margin:16px 0 0;font-size:14px"><strong>Changed:</strong> ${escapeHtml(changed)}</p>`
    );
  }

  // Which of the organization's saved searches this is for, so a supplier with
  // several can tell "IT hardware" apart from "Road works" without opening it.
  const matched = matchedSearchesLine(payload);
  if (matched) {
    lines.push('', `Matched: ${matched}`);
    html.push(
      `<p style="margin:16px 0 0;font-size:14px"><strong>Matched:</strong> ${escapeHtml(matched)}</p>`
    );
  }

  // Why this matched, so a noisy profile can be recognised and narrowed.
  if (payload.reasons?.length) {
    const why = payload.reasons.slice(0, 3).join(' · ');
    lines.push('', why);
    html.push(
      `<p style="margin:16px 0 0;font-size:13px;color:#6b7280;font-style:italic">${escapeHtml(why)}</p>`
    );
  }

  const url = tenderLink(payload, notification.tender_id);
  if (url) {
    lines.push('', url);
    html.push(button(url, 'Open tender'));
  }

  return { text: lines.join('\n'), html: html.join('\n') };
};

/**
 * One notification as `{ subject, text, html }`.
 *
 * Built from `notification.payload` alone so the formatter needs no database
 * access. Every field is optional: notifications raised before a payload field
 * existed must still render, so a missing value drops its line rather than
 * printing "undefined".
 */
export const formatNotification = (notification, { now = new Date(), unsubscribeUrl = null } = {}) => {
  const payload = notification.payload ?? {};
  const { label } = headingFor(notification.type);
  const body = isVaultType(notification.type)
    ? vaultBody(notification, payload, now)
    : isTeamType(notification.type)
      ? teamBody(notification, payload)
      : isSubscriptionType(notification.type)
        ? subscriptionBody(notification, payload)
        : tenderBody(notification, payload, now);

  return {
    subject: subjectFor(notification, payload),
    text: [label, '', body.text, '', '—', footer(unsubscribeUrl)].join('\n'),
    html: layout(label, [body.html, footerHtml(unsubscribeUrl)]),
  };
};

/**
 * One destination's digest as `{ subject, text, html }`: one block per tender —
 * title, deadline, link — and the same footer and unsubscribe link as an alert.
 * `items` arrive already one per tender, read as the tenders are at send time.
 */
export const formatDigest = (items, { now = new Date(), unsubscribeUrl = null } = {}) => {
  const title = digestTitle(items.length);
  const text = [];
  const html = [];

  for (const item of items) {
    const name = item.title ?? item.referenceCode ?? 'Untitled tender';
    const due = deadline(item.deadlineAt, now);
    const url = tenderLink({ sourceUrl: item.sourceUrl }, item.tenderId);

    text.push('', name);
    if (due) text.push(`Deadline: ${due}`);
    if (url) text.push(url);

    html.push(
      `<p style="margin:16px 0 4px;font-size:15px;font-weight:600;line-height:1.4">${escapeHtml(name)}</p>`
    );
    if (due) html.push(fact('Deadline', due));
    if (url) {
      html.push(
        `<p style="margin:0;font-size:14px"><a href="${escapeHtml(url)}" style="color:#1a56db">Open tender</a></p>`
      );
    }
  }

  return {
    // No emoji, as for every alert subject; the words carry it.
    subject: title,
    text: [title, ...text, '', '—', footer(unsubscribeUrl)].join('\n'),
    html: layout(title, [html.join('\n'), footerHtml(unsubscribeUrl)]),
  };
};

export default { formatNotification, formatDigest };
