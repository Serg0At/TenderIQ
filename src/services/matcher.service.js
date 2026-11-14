import { compareCpv, tenderCodes, INFERRED_CPV_MARK } from '../libs/cpv.js';
import { gateKindOf } from '../libs/purchaseKinds.js';

/**
 * Does a tender match a saved search, and how well?
 *
 * Pure scoring — no database, no queue — so the relevance rule can be reasoned
 * about and tested on its own. Precision is the thing that matters here: the
 * spec's warning is that "noise kills trust", and an alert stream a supplier
 * learns to ignore is worth less than no alert stream at all.
 */

/**
 * CPV codes are hierarchical: 33141211 sits under 33140000 under 33000000. The
 * rule itself lives in libs/cpv.js, shared with relevance; this keeps only the
 * alert's question — the FIRST pair, in profile order, that the search covers.
 * A profile asking for 33000000 (medical) matches 33141211, but a profile
 * asking for 33141211 must NOT match all of 33000000.
 */
const cpvMatches = (tenderCodes, profileCodes) => {
  for (const wanted of profileCodes) {
    for (const have of tenderCodes) {
      if (!have) continue;
      const { level, covered } = compareCpv(have, wanted);
      if (level === 'exact') return { hit: true, exact: true };
      if (covered) return { hit: true, exact: false };
    }
  }
  return { hit: false, exact: false };
};

const keywordMatches = (haystack, keywords) => {
  const text = haystack.toLowerCase();
  const hits = keywords.filter((k) => text.includes(String(k).toLowerCase()));
  return { hit: hits.length > 0, hits };
};

/**
 * The CPV half of a match: stated codes first, and only when they miss, the
 * codes behind the gate too (cpv-inference ticket 05, ADR 0006). `inferred`
 * is true when the hit rests on an inferred code alone — a stated hit, even a
 * family one, is never reported as inferred, because the buyer said it.
 */
const cpvMatch = (tender, profileCodes, gate) => {
  const stated = { cpvCode: tender.cpvCode, cpvCodes: tender.cpvCodes, lotCodes: tender.lotCpvCodes };
  const byStated = cpvMatches(tenderCodes(stated), profileCodes);
  if (byStated.hit) return { ...byStated, inferred: false };
  const all = tenderCodes(
    { ...stated, inferredLotCodes: tender.inferredLotCpvCodes, purchaseKind: tender.purchaseKind },
    gate
  );
  const byAll = cpvMatches(all, profileCodes);
  return { ...byAll, inferred: byAll.hit };
};

/**
 * Score in 0..1. Weights follow the spec's match rule: CPV overlap OR keyword
 * hit qualifies, then region and value act as filters rather than boosts.
 *
 * `inferredKinds` is the inferred-CPV gate (config.CPV_INFERENCE.READ_KINDS),
 * passed in so this stays pure; shut by default. An inferred code scores as a
 * stated one would, and its reason says it was inferred (`INFERRED_CPV_MARK`),
 * so an alert can tell a supplier how far to trust it.
 */
export const scoreMatch = (tender, profile, { inferredKinds = [] } = {}) => {
  const cpv = cpvMatch(tender, profile.cpvCodes ?? [], { inferredKinds });
  const haystack = [tender.title, tender.referenceCode, tender.description, ...(tender.lotNames ?? [])]
    .filter(Boolean)
    .join(' \n ');
  const keyword = keywordMatches(haystack, profile.keywords ?? []);

  if (!cpv.hit && !keyword.hit) return { matched: false, score: 0, reasons: [], inferredCpv: false };

  // Value range is a hard filter: a supplier who set a floor is telling you
  // anything below it is not worth their attention, not that it scores lower.
  const value = tender.estimatedValue === null || tender.estimatedValue === undefined
    ? null
    : Number(tender.estimatedValue);
  if (value !== null) {
    if (profile.minValue !== null && profile.minValue !== undefined && value < Number(profile.minValue)) {
      return { matched: false, score: 0, reasons: ['below minValue'] };
    }
    if (profile.maxValue !== null && profile.maxValue !== undefined && value > Number(profile.maxValue)) {
      return { matched: false, score: 0, reasons: ['above maxValue'] };
    }
  }

  const regions = profile.regions ?? [];
  if (regions.length && tender.buyerRegion) {
    const inRegion = regions.some((r) => tender.buyerRegion.toLowerCase().includes(String(r).toLowerCase()));
    if (!inRegion) return { matched: false, score: 0, reasons: ['outside region'] };
  }

  const reasons = [];
  let score = 0;
  if (cpv.hit) {
    score += cpv.exact ? 0.7 : 0.5;
    const reason = cpv.exact ? 'exact CPV match' : 'CPV family match';
    reasons.push(cpv.inferred ? `${reason} ${INFERRED_CPV_MARK}` : reason);
  }
  if (keyword.hit) {
    // Weighted to clear MATCH_THRESHOLD on its own: the spec's rule is "CPV
    // overlap OR keyword hit", so a keyword-only profile must be able to fire.
    // Scoring it below the threshold made those profiles silently dead.
    // Diminishing after the first: three hits is not three times as relevant.
    score += Math.min(0.5 + 0.05 * (keyword.hits.length - 1), 0.65);
    reasons.push(`keyword: ${keyword.hits.slice(0, 3).join(', ')}`);
  }

  return { matched: true, score: Math.min(Number(score.toFixed(2)), 1), reasons, inferredCpv: cpv.inferred };
};

/**
 * A tender as `scoreMatch` reads it, from `TenderRepository.findDetail`. One
 * mapping, so the CPV backfill counts the matches it would raise with exactly
 * the candidate the alert job builds.
 */
export const matchCandidate = (tender) => ({
  cpvCode: tender.cpv_code,
  // Every code the source states for the tender, including any it could not
  // put on a lot — a search naming one of those must still hear about it.
  cpvCodes: tender.cpv_codes ?? [],
  lotCpvCodes: (tender.lots ?? []).map((l) => l.cpv_code).filter(Boolean),
  // Inferred lot codes (ADR 0006), which `scoreMatch` reads only behind the
  // gate, and the kind the gate decides on: the source's label, else what the
  // procedure code names — paper states no label.
  inferredLotCpvCodes: (tender.lots ?? []).map((l) => l.inferred_cpv_code).filter(Boolean),
  purchaseKind: gateKindOf({ label: tender.goods_works_services, referenceCode: tender.reference_code }),
  lotNames: (tender.lots ?? []).map((l) => l.name).filter(Boolean),
  title: tender.title,
  // A paper invitation's contract subject (null elsewhere). Read by keywords,
  // because a paper tender's lots arrive with its document stage, after the
  // ingest match has run.
  description: tender.description ?? null,
  referenceCode: tender.reference_code,
  estimatedValue: tender.estimated_value,
  buyerRegion: tender.buyer_region,
});

/**
 * Only live tenders are worth interrupting someone for: an award or a
 * cancellation is history, and alerting on it trains people to ignore alerts.
 */
export const ALERTABLE_STATUSES = ['active', 'planned', 'amended'];

/**
 * Pure: whether a supplier could still act on an amendment — a status the
 * matcher alerts on and a deadline ahead or none. Past the deadline, closed,
 * awarded or cancelled, the version is recorded and nobody is told. The
 * deadline half is the one tender.repo.js#findRankable applies in SQL for a
 * biddable tender; they move together.
 */
export const isOpen = ({ status, deadlineAt }, now) =>
  ALERTABLE_STATUSES.includes(status) && (!deadlineAt || new Date(deadlineAt).getTime() > now.getTime());

/** Below this a match is too weak to interrupt someone's day. */
export const MATCH_THRESHOLD = 0.5;

/**
 * Every saved search a tender matches, grouped by the organization that owns it.
 *
 * The alert is decided per organization, not per search. Notifications dedupe on
 * (organization, type, tender), so a loop that raised one per search let the
 * first match in `listAll()` order name the alert and pick its channels, and
 * every later match in the same organization vanished — its name unmentioned
 * and its channels never attempted. Grouping first is what lets one alert speak
 * for all of them.
 *
 * Matches are best score first with `id` as the tiebreaker, so the order an
 * alert lists them in does not depend on the order rows came back in.
 *
 * `inferredKinds` is the inferred-CPV gate, handed to `scoreMatch`.
 */
export const matchesByOrganization = (tender, profiles, { inferredKinds = [] } = {}) => {
  const groups = new Map();

  for (const profile of profiles) {
    const result = scoreMatch(tender, {
      cpvCodes: profile.cpv_codes ?? [],
      keywords: profile.keywords ?? [],
      regions: profile.regions ?? [],
      minValue: profile.min_value,
      maxValue: profile.max_value,
    }, { inferredKinds });
    if (!result.matched || result.score < MATCH_THRESHOLD) continue;

    const match = {
      id: profile.id,
      name: profile.name,
      score: result.score,
      reasons: result.reasons,
      // True when this search's CPV hit rests on an inferred code alone; a
      // digest line, which shows no reasons, marks the search by it.
      inferredCpv: result.inferredCpv,
      channels: profile.channels ?? [],
    };
    const group = groups.get(profile.organization_id);
    if (group) group.push(match);
    else groups.set(profile.organization_id, [match]);
  }

  return [...groups].map(([organizationId, matches]) => ({
    organizationId,
    matches: matches.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  }));
};

/**
 * The pursuits that hear about an amendment with or without a matching search.
 *
 * `submitted` is in: on ARMEPS and paper a sealed bid can be withdrawn or
 * replaced before the deadline, so an addendum after submission is exactly
 * when a supplier needs to know — Tendra's own locked snapshot does not change
 * that. `won`, `lost` and `dropped` are out: the tender is decided for them, or
 * they walked away, and results reach a tracker through bid reconciliation.
 */
export const AMENDMENT_PURSUITS = ['considering', 'preparing', 'submitted'];

/**
 * Who hears about one alert: the organizations whose searches matched it, plus
 * the organizations tracking it (`trackersOf`), each once.
 *
 * One list rather than a second producer, because two producers would be two
 * answers to "who hears about this amendment". An organization that matches and
 * tracks is one recipient carrying both its matches and its `pipelineStatus`; a
 * tracker with no matching search is one with `matches: []`. An ingest alert
 * passes no trackers — an organization tracking a tender already knows it
 * exists — so its recipients are the matches alone.
 */
export const alertRecipients = (groups, trackers = []) => {
  const recipients = new Map(
    groups.map(({ organizationId, matches }) => [organizationId, { organizationId, matches, pipelineStatus: null }])
  );
  for (const { organization_id: organizationId, status } of trackers) {
    const recipient = recipients.get(organizationId);
    if (recipient) recipient.pipelineStatus = status;
    else recipients.set(organizationId, { organizationId, matches: [], pipelineStatus: status });
  }
  return [...recipients.values()];
};

/**
 * Where one organization's alert goes, given every search that matched and
 * whether it tracks the tender.
 *
 * The union of what the searches name, because each search asked for its
 * channels and none of them outranks another. A search that names nothing means
 * "however this organization can be reached", and a sibling naming one specific
 * channel must not narrow that — so `useOrgDefault` is true when ANY match is
 * empty, and the caller adds the organization's reachable channels on top.
 */
export const channelsForMatches = (matches, { tracking = false } = {}) => ({
  named: [...new Set(matches.flatMap((m) => m.channels))],
  // Tracking names no channel either, so it asks for the same: a search that
  // narrows its own alert to one channel does not narrow the tracker's.
  useOrgDefault: tracking || matches.some((m) => !m.channels.length),
});

export default {
  scoreMatch,
  matchCandidate,
  ALERTABLE_STATUSES,
  isOpen,
  MATCH_THRESHOLD,
  AMENDMENT_PURSUITS,
  matchesByOrganization,
  alertRecipients,
  channelsForMatches,
};
