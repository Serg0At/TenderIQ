import { compareCpv, tenderCodes } from '../libs/cpv.js';

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
 * Score in 0..1. Weights follow the spec's match rule: CPV overlap OR keyword
 * hit qualifies, then region and value act as filters rather than boosts.
 */
export const scoreMatch = (tender, profile) => {
  const codes = tenderCodes({ cpvCode: tender.cpvCode, cpvCodes: tender.cpvCodes, lotCodes: tender.lotCpvCodes });
  const cpv = cpvMatches(codes, profile.cpvCodes ?? []);
  const haystack = [tender.title, tender.referenceCode, ...(tender.lotNames ?? [])].filter(Boolean).join(' \n ');
  const keyword = keywordMatches(haystack, profile.keywords ?? []);

  if (!cpv.hit && !keyword.hit) return { matched: false, score: 0, reasons: [] };

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
    reasons.push(cpv.exact ? 'exact CPV match' : 'CPV family match');
  }
  if (keyword.hit) {
    // Weighted to clear MATCH_THRESHOLD on its own: the spec's rule is "CPV
    // overlap OR keyword hit", so a keyword-only profile must be able to fire.
    // Scoring it below the threshold made those profiles silently dead.
    // Diminishing after the first: three hits is not three times as relevant.
    score += Math.min(0.5 + 0.05 * (keyword.hits.length - 1), 0.65);
    reasons.push(`keyword: ${keyword.hits.slice(0, 3).join(', ')}`);
  }

  return { matched: true, score: Math.min(Number(score.toFixed(2)), 1), reasons };
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
  lotNames: (tender.lots ?? []).map((l) => l.name).filter(Boolean),
  title: tender.title,
  referenceCode: tender.reference_code,
  estimatedValue: tender.estimated_value,
  buyerRegion: tender.buyer_region,
});

/**
 * Only live tenders are worth interrupting someone for: an award or a
 * cancellation is history, and alerting on it trains people to ignore alerts.
 */
export const ALERTABLE_STATUSES = ['active', 'planned', 'amended'];

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
 */
export const matchesByOrganization = (tender, profiles) => {
  const groups = new Map();

  for (const profile of profiles) {
    const result = scoreMatch(tender, {
      cpvCodes: profile.cpv_codes ?? [],
      keywords: profile.keywords ?? [],
      regions: profile.regions ?? [],
      minValue: profile.min_value,
      maxValue: profile.max_value,
    });
    if (!result.matched || result.score < MATCH_THRESHOLD) continue;

    const match = {
      id: profile.id,
      name: profile.name,
      score: result.score,
      reasons: result.reasons,
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
 * Where one organization's alert goes, given every search that matched.
 *
 * The union of what the searches name, because each search asked for its
 * channels and none of them outranks another. A search that names nothing means
 * "however this organization can be reached", and a sibling naming one specific
 * channel must not narrow that — so `useOrgDefault` is true when ANY match is
 * empty, and the caller adds the organization's reachable channels on top.
 */
export const channelsForMatches = (matches) => ({
  named: [...new Set(matches.flatMap((m) => m.channels))],
  useOrgDefault: matches.some((m) => !m.channels.length),
});

export default { scoreMatch, matchCandidate, ALERTABLE_STATUSES, MATCH_THRESHOLD, matchesByOrganization, channelsForMatches };
