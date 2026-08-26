/**
 * Does a tender match a saved search, and how well?
 *
 * Pure scoring — no database, no queue — so the relevance rule can be reasoned
 * about and tested on its own. Precision is the thing that matters here: the
 * spec's warning is that "noise kills trust", and an alert stream a supplier
 * learns to ignore is worth less than no alert stream at all.
 */

/** CPV codes are hierarchical: 33141211 sits under 33140000 under 33000000. */
const cpvMatches = (tenderCodes, profileCodes) => {
  for (const wanted of profileCodes) {
    const prefix = String(wanted).replace(/0+$/, '');
    for (const have of tenderCodes) {
      if (!have) continue;
      if (have === wanted) return { hit: true, exact: true };
      // A profile asking for 33000000 (medical) should match 33141211, but a
      // profile asking for 33141211 must NOT match all of 33000000.
      if (prefix && String(have).startsWith(prefix)) return { hit: true, exact: false };
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
  const tenderCodes = [tender.cpvCode, ...(tender.lotCpvCodes ?? [])].filter(Boolean);
  const cpv = cpvMatches(tenderCodes, profile.cpvCodes ?? []);
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

/** Below this a match is too weak to interrupt someone's day. */
export const MATCH_THRESHOLD = 0.5;

export default { scoreMatch, MATCH_THRESHOLD };
