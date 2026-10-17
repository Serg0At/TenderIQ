import { bestCpvMatch, covers } from '../libs/cpv.js';
import { FIELDS } from '../libs/fields.js';

/**
 * Relevance: how well each biddable tender fits one organization.
 *
 * Pure — candidates, the organization's signal bundle and a clock reading in,
 * an ordered list out. No database, no queue, no clock of its own, the shape
 * `matcher.service.js` already has. That is what lets the backtest replay a
 * ranking at a past date with the production rule unchanged, and it is the seam
 * a test suite would attach to.
 *
 * Relevance is not a Match. A Match decides whether an alert fires; this only
 * orders a list, and nothing here is read by the alert pipeline — tuning these
 * weights can never change which alerts go out. It never hides a tender either:
 * one that fits nothing scores 0 and sits at the bottom, not outside.
 *
 * Scoring is additive with diminishing returns. Each signal contributes a
 * strength in [0, 1) and they combine as 1 − Π(1 − s): two medium signals beat
 * one, and nothing ever reaches 1. A tender is scored on its BEST lot — an
 * 18-lot procurement whose lot 7 is the supplier's category must not be buried
 * by averaging in seventeen lots that are not — and the reasons name that lot.
 */

/**
 * The tunable numbers, in one place so the backtest can print what it measured.
 * A signal's strength is its weight, scaled by how close the CPV match is.
 */
export const WEIGHTS = {
  savedSearch: 0.4,
  field: 0.25,
};

/** How much of a signal survives a weaker CPV match. */
export const CLOSENESS = { exact: 1, group: 0.7, division: 0.4 };

/** A saved-search keyword hit counts like a same-group code: deliberate, but not a code. */
export const KEYWORD_FACTOR = 0.8;

/**
 * Score bands. A band is what a screen shows; the number is for tooling. Every
 * row carries its band, so a week where nothing fits reads as weak all the way
 * down instead of the top row looking like a win.
 */
export const BANDS = [
  { band: 'strong', min: 0.6 },
  { band: 'moderate', min: 0.35 },
  { band: 'weak', min: 0 },
];

export const bandOf = (score) => BANDS.find((b) => score >= b.min).band;

/** The signal sources an organization can have, in the order a client should offer them. */
const BASIS_SOURCES = [
  ['field', (s) => FIELDS.some((f) => (s.fields ?? []).includes(f.id))],
  ['saved_search', (s) => (s.savedSearches ?? []).length > 0],
];

/**
 * Whether there is anything to rank on, and what is missing.
 *
 * With no basis at all the honest answer is "insufficient", not an order: every
 * tender would score 0 and the list would be sorted by deadline while looking
 * like a ranking. `missing` names each absent source so a client can offer the
 * button that fixes it.
 */
export const basisOf = (signals) => {
  const missing = BASIS_SOURCES.filter(([, present]) => !present(signals)).map(([name]) => name);
  return { sufficient: missing.length < BASIS_SOURCES.length, missing };
};

const combine = (strengths) => 1 - strengths.reduce((rest, s) => rest * (1 - s), 1);

const round = (n) => Math.round(n * 10000) / 10000;

/**
 * The units a tender is scored on: one per lot, carrying that lot's codes and
 * the saved-search keywords its item names contain (`keywordHits`, computed by
 * the repository so the names never have to be loaded). A headline code no lot
 * carries gets a unit of its own; a tender with neither still gets one, so its
 * title can still be read.
 */
const unitsOf = (tender) => {
  const lots = tender.lots ?? [];
  const units = lots.map((lot) => ({ lot: lot.lotNumber, codes: lot.codes ?? [], keywordHits: lot.keywordHits ?? [] }));
  const lotCodes = new Set(units.flatMap((u) => u.codes));
  if (tender.cpvCode && !lotCodes.has(tender.cpvCode)) units.push({ lot: null, codes: [tender.cpvCode], keywordHits: [] });
  if (!units.length) units.push({ lot: null, codes: [], keywordHits: [] });
  return units;
};

/** Does a keyword occur in this unit — its lot names, or the tender's title or reference? */
const keywordIn = (tender, unit, keyword) => {
  if (!keyword) return false;
  if (unit.keywordHits.includes(keyword)) return true;
  const needle = String(keyword).toLowerCase();
  return [tender.title, tender.referenceCode].some((text) => text && text.toLowerCase().includes(needle));
};

const inValueRange = (value, search) => {
  if (value === null || value === undefined) return true;
  const v = Number(value);
  if (search.minValue !== null && search.minValue !== undefined && v < Number(search.minValue)) return false;
  if (search.maxValue !== null && search.maxValue !== undefined && v > Number(search.maxValue)) return false;
  return true;
};

/**
 * The organization's saved searches, read as claims about what it wants.
 *
 * The best-matching search contributes, not the sum: five overlapping searches
 * are one claim typed five times. A code the search COVERS counts in full — a
 * search for a whole division asked for all of it — and a merely nearby code
 * counts by closeness. A search whose value range excludes the tender is not
 * consulted, the same reading the alert gives a range. Region is not read: no
 * buyer carries one.
 */
const savedSearchSignal = (tender, unit, searches) => {
  let best = null;
  for (const search of searches) {
    if (!inValueRange(tender.estimatedValue, search)) continue;

    const match = bestCpvMatch(unit.codes, search.cpvCodes ?? []);
    if (match.level !== 'none') {
      const covered = covers(match.wanted, match.code);
      const strength = WEIGHTS.savedSearch * (covered ? 1 : CLOSENESS[match.level]);
      if (!best || strength > best.strength) {
        best = {
          strength,
          reason: { code: 'saved_search', searchId: search.id, searchName: search.name, match: 'cpv', level: match.level, covered, cpvCode: match.code, lot: unit.lot },
        };
      }
    }

    const hits = (search.keywords ?? []).filter((k) => keywordIn(tender, unit, k));
    if (hits.length) {
      const strength = WEIGHTS.savedSearch * KEYWORD_FACTOR;
      if (!best || strength > best.strength) {
        best = {
          strength,
          reason: { code: 'saved_search', searchId: search.id, searchName: search.name, match: 'keyword', keywords: hits.slice(0, 3), lot: unit.lot },
        };
      }
    }
  }
  return best ? [best] : [];
};

/** The organization's claimed fields: weak, flat, and the only signal a brand-new account has. */
const fieldSignal = (unit, fields) => {
  for (const field of FIELDS) {
    if (!fields.includes(field.id)) continue;
    const code = unit.codes.find((c) => field.cpvPrefixes.some((p) => String(c).startsWith(p)));
    if (code) return [{ strength: WEIGHTS.field, reason: { code: 'field', field: field.id, cpvCode: code, lot: unit.lot } }];
  }
  return [];
};

/** One tender, all its units scored, the best one kept. */
const scoreTender = (tender, signals) => {
  let best = null;
  for (const unit of unitsOf(tender)) {
    const positives = [
      ...savedSearchSignal(tender, unit, signals.savedSearches ?? []),
      ...fieldSignal(unit, signals.fields ?? []),
    ];
    const score = combine(positives.map((p) => p.strength));
    if (!best || score > best.score) {
      best = {
        score,
        reasons: positives.sort((a, b) => b.strength - a.strength).map((p) => p.reason),
      };
    }
  }
  const score = round(best.score);
  return { score, band: bandOf(score), reasons: best.reasons };
};

/**
 * The full sort key: score descending, then the tender closing soonest, with no
 * deadline last, then id. The cursor encodes all three, so paging through a
 * ranking computed per request neither repeats nor skips a row.
 */
export const compareRanked = (a, b) => {
  if (a.score !== b.score) return b.score - a.score;
  const da = a.deadlineAt ? new Date(a.deadlineAt).getTime() : Number.POSITIVE_INFINITY;
  const dbb = b.deadlineAt ? new Date(b.deadlineAt).getTime() : Number.POSITIVE_INFINITY;
  if (da !== dbb) return da - dbb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Rank candidate tenders for one organization.
 *
 * @param {Array}  candidates  `{ id, title, referenceCode, cpvCode, buyerId, estimatedValue, deadlineAt, lots: [{ lotNumber, codes, keywordHits }] }`
 * @param {object} signals     `{ fields, savedSearches }`
 * @param {object} options     `{ now }` — read by nothing yet; every later signal ages against it
 * @returns {Array} `{ tender, id, deadlineAt, score, band, reasons }`, best first
 */
export const rankTenders = (candidates, signals, { now } = {}) => {
  if (!(now instanceof Date)) throw new Error('rankTenders needs an explicit `now`');
  return candidates
    .map((tender) => ({ tender, id: tender.id, deadlineAt: tender.deadlineAt ?? null, ...scoreTender(tender, signals) }))
    .sort(compareRanked);
};

export default { WEIGHTS, CLOSENESS, BANDS, bandOf, basisOf, rankTenders, compareRanked };
