import config from '../../../configs/variables.config.js';

const { APP } = config;

/**
 * The facts an alert states, rendered for a human — shared by every channel
 * formatter. Pure: no I/O, no database, and the clock only ever arrives as an
 * argument.
 *
 * This exists because the second channel proved these were never Telegram's.
 * A deadline reads "in 3 days" for the same reason in an email as in a chat
 * message, and a heading table that lives in one channel's file is a heading
 * table the other channel gets subtly wrong. What stays channel-specific is
 * the markup and the envelope; what a notification *means* is one answer.
 */

/**
 * The channels an alert can actually be delivered on.
 *
 * One list, imported by everything that needs to know — the delivery registry,
 * the transport table, and the saved-search schema that lets a customer pick.
 * They were three separate lists once, and the drift between them is what made
 * `channels: ['email']` a valid saved search that reached nobody for months: the
 * schema offered a channel the dispatcher answered with "not implemented", and
 * every match quietly recorded a failed delivery.
 *
 * `log` is not here. It is the operator's record that an alert was raised, not a
 * way to reach a customer, and offering it in a settings screen would let
 * someone choose a channel that reaches nothing.
 *
 * Adding a channel means adding it here AND giving it a transport;
 * `notifier.service.js` refuses to load if those two disagree.
 */
export const DELIVERABLE_CHANNELS = ['telegram', 'email'];

/** AMD with thousands separators. Armenian procurement values run to billions. */
export const money = (amount, currency = 'AMD') => {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${currency}`;
};

/** Absolute date plus a relative hint, because "in 3 days" is what gets acted on. */
export const deadline = (value, now = new Date()) => {
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
   * Telegram sanitises links its own way and a mail client may not, so the
   * boundary that knows this value came from a crawled page is this one.
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

/** A deep link into the product, or null while there is no frontend to link to. */
export const appLink = (path) =>
  APP.BASE_URL ? `${APP.BASE_URL.replace(/\/+$/, '')}${path}` : null;

/**
 * Heading per notification type, split into the emoji and the words.
 *
 * Split because the two channels want different halves. Telegram renders both —
 * an emoji is how a chat message is skimmed. An email subject line wants the
 * words carrying meaning on their own, since a subject that opens with an emoji
 * is a spam-filter signal and is what some clients truncate first.
 */
export const HEADINGS = {
  'tender-match': { emoji: '🎯', label: 'New matching tender' },
  amendment: { emoji: '✏️', label: 'Tender amended' },
  reminder: { emoji: '⏰', label: 'Deadline approaching' },
  // Distinct from `reminder` on purpose: a countdown fires only on a tender the
  // supplier said they are pursuing, so it deserves a heading that reads as
  // "your bid", not "a tender exists".
  countdown: { emoji: '🚨', label: 'Bid deadline — you are pursuing this' },
  expiry: { emoji: '⌛', label: 'Tender closing' },
  // Checked before `expiry` would ever be reached, and named in full: a vault
  // alert is about the company's own certificate, not about a tender closing,
  // and the two must not share a heading.
  'vault-expiry': { emoji: '📄', label: 'Document expiring' },
  'vault-expired': { emoji: '⛔', label: 'Document expired' },
  // Team announcements. Organization-wide by construction — delivery has no
  // per-recipient targeting — so each is worded as news about the company,
  // never as a message to one person.
  'team-invitation': { emoji: '✉️', label: 'Team invitation sent' },
  'team-role-changed': { emoji: '👥', label: 'Team role changed' },
  'team-member-removed': { emoji: '🚪', label: 'Team member removed' },
  'team-ownership-transferred': { emoji: '🔑', label: 'Ownership transferred' },
};

const FALLBACK_HEADING = { emoji: '🔔', label: 'Tender alert' };

/**
 * Longest key first, so a prefix match cannot be stolen by a shorter one.
 * `vault-expiry-30d` must not fall to `expiry`, and `vault-expired` must not
 * fall to `vault-expiry` — object key order is insertion order, which is a
 * fragile thing to depend on.
 */
const HEADING_KEYS = Object.keys(HEADINGS).sort((a, b) => b.length - a.length);

/**
 * Matched by prefix, not by exact key: the reminder worker emits `reminder-72h`
 * and `reminder-24h`, one type per threshold, so an exact lookup on `reminder`
 * silently fell through to the generic heading for every deadline reminder —
 * the alerts most likely to be acted on.
 */
const keyFor = (type) =>
  HEADING_KEYS.find((k) => type === k || String(type ?? '').startsWith(`${k}-`)) ?? null;

export const headingFor = (type) => {
  const key = keyFor(type);
  return key ? HEADINGS[key] : FALLBACK_HEADING;
};

/**
 * The family a raw type belongs to — `reminder-72h` and `reminder-24h` are both
 * `reminder` — or the type itself when it matches no family.
 *
 * This is what a user mutes. Offering the raw types instead would ask someone to
 * switch off `reminder-72h` and leave `reminder-24h` on, which nobody wants and
 * which quietly breaks every time a worker adds a threshold. Sharing the prefix
 * rule with the headings is the point: a family that can be muted but has no
 * heading, or the reverse, is an alert that names the wrong thing.
 */
/** True for the alerts that are about the org's own document rather than a tender. */
export const isVaultType = (type) => String(type ?? '').startsWith('vault-');

/** True for organization-wide announcements about who is on the team. */
export const isTeamType = (type) => String(type ?? '').startsWith('team-');

/**
 * The one sentence a team announcement says, shared by every channel.
 *
 * Third person and named, never "you": the notification reaches every linked
 * destination in the organization, so a message worded to one person would be
 * read by all of them. It also uses the member's name rather than a pronoun —
 * nothing here knows anyone's pronouns, and a wrong guess in a company-wide
 * message is worse than repeating a name.
 *
 * An invitation names the role and who sent it, never the address: a viewer's
 * linked chat receives this, and a viewer must never see an invited address.
 */
export const teamAnnouncement = (type, payload = {}) => {
  const org = payload.organizationName || 'the organization';
  const name = payload.memberName || 'A member';
  const role = payload.role || 'member';

  switch (type) {
    case 'team-invitation':
      return payload.invitedByName
        ? `${payload.invitedByName} invited a new ${role} to join ${org}.`
        : `A new ${role} has been invited to join ${org}.`;
    case 'team-role-changed':
      return `${name}'s role in ${org} has been changed to ${role}.`;
    case 'team-member-removed':
      return `${name} has been removed from ${org}.`;
    case 'team-ownership-transferred':
      return `Ownership of ${org} has passed from ${payload.previousOwnerName} to ${name}.`;
    default:
      return `The team at ${org} has changed.`;
  }
};

export default {
  DELIVERABLE_CHANNELS,
  money,
  deadline,
  tenderLink,
  appLink,
  headingFor,
  isVaultType,
  isTeamType,
  teamAnnouncement,
  HEADINGS,
};
