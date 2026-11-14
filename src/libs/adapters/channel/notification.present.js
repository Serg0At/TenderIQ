import config from '../../../configs/variables.config.js';
import { INFERRED_CPV_MARK } from '../../cpv.js';

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
  // No value is no line: `Number(null)` is 0, and "0 AMD" is a value nobody published.
  if (amount === null || amount === undefined || amount === '') return null;
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
  // Subscription announcements, organization-wide for the same reason.
  'subscription-ending': { emoji: '⏳', label: 'Subscription ending' },
  'subscription-ended': { emoji: '🔒', label: 'Subscription ended' },
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
/**
 * The saved searches a match alert was raised for, as one line — or null.
 *
 * Null for a notification raised before `matchedSearches` existed, and for any
 * type that is not a match, so the line is simply absent rather than empty.
 * Names are listed best match first, which is the order the matcher stored.
 *
 * `markInferred` adds `INFERRED_CPV_MARK` after a search whose CPV reason
 * rests on an inferred code alone (cpv-inference ticket 05). The digest asks
 * for it, because a digest line shows no reasons; an instant alert does not,
 * because its reasons line already says so. A search stored before the flag
 * existed carries none and reads as it always did.
 */
export const matchedSearchesLine = (payload = {}, { markInferred = false } = {}) => {
  const names = (payload.matchedSearches ?? [])
    .filter((m) => m?.name)
    .map((m) => (markInferred && m.inferredCpv ? `${m.name} ${INFERRED_CPV_MARK}` : m.name));
  return names.length ? names.join(', ') : null;
};

/**
 * What an amendment changed, as one line — or null.
 *
 * The fields that moved, then each document an addendum added, replaced or
 * removed (`documentChanges`, services/addendum.service.js), by its file name.
 * An addendum moves no field, so its line names only documents: an alert that
 * said a field changed when none did would teach people to stop reading them.
 */
export const changeLine = (payload = {}) => {
  const docs = payload.documentChanges ?? {};
  const parts = [
    ...(payload.changedFields ?? []),
    ...(docs.added ?? []).map((name) => `new document: ${name}`),
    ...(docs.replaced ?? []).map((name) => `replaced document: ${name}`),
    ...(docs.removed ?? []).map((name) => `removed document: ${name}`),
  ];
  return parts.length ? parts.join(', ') : null;
};

/**
 * A digest's heading, shared by every channel so a Telegram digest and an email
 * digest of the same morning say the same thing. `count` is the tenders listed.
 */
export const DIGEST_HEADING = { emoji: '📬', label: 'Daily digest' };

export const digestTitle = (count) =>
  `${DIGEST_HEADING.label}: ${count} new matching tender${count === 1 ? '' : 's'}`;

/** The most tenders one digest lists; the rest are counted, never dropped. */
export const DIGEST_MAX_LINES = 20;

/**
 * Telegram refuses a message longer than this, counted after its HTML is
 * parsed — the visible text, in UTF-16 units, which is a JavaScript string's
 * `length`. A refused message is a permanent failure that counts against the
 * destination, so the digest is sized to it before it is rendered.
 */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * An upper bound on what a renderer adds around a line's values: emoji,
 * labels, separators, newlines, the "Open tender" anchor text. Telegram's
 * renderer adds about 45; the slack is what lets its wording change without
 * this file noticing. A renderer whose frame outgrows it is the one change
 * that can push a digest past the limit.
 */
const LINE_FRAME = 64;

/** The heading and the "…and N more" line, with the same slack. */
const DIGEST_FRAME = 160;

/**
 * One line cannot crowd out the list: clipped at lengths the corpus does not
 * reach today (the longest stored title is 365), so they only ever bite on a
 * value that would otherwise take a fifth of the message.
 */
const CLIP = { title: 400, buyer: 200, matched: 300 };

const clip = (value, max) =>
  value && value.length > max ? `${value.slice(0, max - 1)}…` : value ?? null;

/**
 * A status's one word in a digest. `amended` keeps its place among the
 * biddable tenders when it is still biddable — the word says to re-read it,
 * not that it is gone.
 */
export const DIGEST_MARKERS = {
  cancelled: 'չեղարկված',
  closed: 'փակված',
  awarded: 'փակված',
  amended: 'փոփոխված',
};

/** CONTEXT.md, "Biddable tender"; the SQL twin is `tender.repo.js#BIDDABLE_STATUSES`. */
const BIDDABLE_STATUSES = ['active', 'amended'];

const isBiddable = (item, now) => {
  if (!BIDDABLE_STATUSES.includes(item.status)) return false;
  if (!item.deadlineAt) return true;
  const at = new Date(item.deadlineAt).getTime();
  return Number.isNaN(at) || at > now.getTime();
};

/** Deadline ascending, a missing one last. */
const deadlineMs = (item) => {
  const at = item.deadlineAt ? new Date(item.deadlineAt).getTime() : NaN;
  return Number.isNaN(at) ? Infinity : at;
};

const visibleLength = (line) =>
  LINE_FRAME +
  [line.marker, line.title, line.buyer, line.budget, line.deadline, line.matched]
    .filter(Boolean)
    .reduce((sum, value) => sum + value.length, 0);

/**
 * What one destination's digest says, decided once for every channel.
 *
 * `items` are one per tender, read as the tenders are at send time
 * (`notifier.service.js#digestItems`). Biddable tenders come first, soonest
 * deadline first; the rest — cancelled, closed, awarded, past their deadline —
 * follow in the same order, each marked. At most `DIGEST_MAX_LINES` are listed,
 * fewer when Telegram's limit would be passed, and the rest are counted.
 * The order is stable, so two tenders with one deadline keep the order they
 * were held in.
 *
 * Relevance plays no part: the digest lists exactly what was matched, in an
 * order every member can predict.
 *
 * Telegram and email both render this object and nothing else, which is what
 * makes them list the same tenders in the same order.
 */
export const digestContent = (items, { now = new Date() } = {}) => {
  const biddable = [];
  const rest = [];
  for (const item of items) (isBiddable(item, now) ? biddable : rest).push(item);
  const byDeadline = (a, b) => deadlineMs(a) - deadlineMs(b);

  const ordered = [...biddable.sort(byDeadline), ...rest.sort(byDeadline)].map((item) => ({
    tenderId: item.tenderId,
    title: clip(item.title ?? item.referenceCode ?? 'Untitled tender', CLIP.title),
    marker: DIGEST_MARKERS[item.status] ?? null,
    buyer: clip(item.buyerName, CLIP.buyer),
    budget: money(item.estimatedValue, item.currency ?? 'AMD'),
    deadline: deadline(item.deadlineAt, now),
    matched: clip(matchedSearchesLine({ matchedSearches: item.matchedSearches }, { markInferred: true }), CLIP.matched),
    // The link an instant alert of this tender carries.
    link: tenderLink({ sourceUrl: item.sourceUrl }, item.tenderId),
  }));

  const lines = [];
  let room = TELEGRAM_MESSAGE_LIMIT - DIGEST_FRAME;
  for (const line of ordered) {
    if (lines.length === DIGEST_MAX_LINES) break;
    const cost = visibleLength(line);
    if (cost > room) break;
    room -= cost;
    lines.push(line);
  }

  const more = ordered.length - lines.length;
  return {
    title: digestTitle(ordered.length),
    lines,
    more,
    moreLine: more ? `…and ${more} more match${more === 1 ? '' : 'es'}` : null,
  };
};

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

/** True for organization-wide announcements about the organization's subscription. */
export const isSubscriptionType = (type) => String(type ?? '').startsWith('subscription-');

const PERIOD_NOUNS = { trial: 'trial', promo: 'promotional period', paid: 'subscription' };

/**
 * A period's end on the Yerevan clock, where every member reads it: an end at
 * 22:00 UTC is the next morning there, and a date alone would put it a day early.
 */
const yerevanTime = (value) => {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Yerevan',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (t) => parts.find((p) => p.type === t)?.value;
  return `${part('day')} ${part('month')} ${part('year')} at ${part('hour')}:${part('minute')} Yerevan time`;
};

/**
 * The sentences a subscription announcement says, shared by every channel.
 *
 * Third person and about the company, like a team announcement: the plan, the
 * kind and the date, never a person. What follows the end is stated as a
 * condition, because the message outlives the sweep that wrote it — a code
 * redeemed the next day would make "is now on Free" false.
 */
export const subscriptionAnnouncement = (type, payload = {}) => {
  const org = payload.organizationName || 'The organization';
  const plan = payload.plan ? `${payload.plan.charAt(0).toUpperCase()}${payload.plan.slice(1)} ` : '';
  const period = `${org}'s ${plan}${PERIOD_NOUNS[payload.periodKind] ?? 'subscription'}`;
  const when = yerevanTime(payload.periodEnd);

  switch (type) {
    case 'subscription-ending':
      return when
        ? `${period} ends on ${when}. Unless another period follows it, the organization returns to the Free plan then.`
        : `${period} ends soon. Unless another period follows it, the organization returns to the Free plan then.`;
    case 'subscription-ended':
      return when
        ? `${period} ended on ${when}. Unless another period has started since, the organization is on the Free plan.`
        : `${period} has ended. Unless another period has started since, the organization is on the Free plan.`;
    default:
      return `${org}'s subscription has changed.`;
  }
};

export default {
  DELIVERABLE_CHANNELS,
  DIGEST_HEADING,
  DIGEST_MAX_LINES,
  DIGEST_MARKERS,
  TELEGRAM_MESSAGE_LIMIT,
  digestTitle,
  digestContent,
  matchedSearchesLine,
  changeLine,
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
  HEADINGS,
};
