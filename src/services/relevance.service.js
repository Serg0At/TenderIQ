import { bestCpvMatch, closeness, covers, tenderCodes, CPV_LEVELS } from '../libs/cpv.js';
import { FIELDS } from '../libs/fields.js';
import { termsOf, buildRarity, buildProfile, overlap } from './termRarity.service.js';

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
  /** Won a lot in this category from this same buyer — the strongest single signal. */
  wonSameBuyer: 0.9,
  /** Won a lot in this category. */
  won: 0.8,
  /** Bid in this category, won or not. A loss is participation, never a penalty. */
  bid: 0.55,
  /** The team pursued a similar tender — what it is actually working on. */
  pursued: 0.55,
  /**
   * A saved search is a claim, and a claim counts for less than the record: a
   * covering match (0.33) stays under a single recent exact bid (≈0.37).
   */
  savedSearch: 0.33,
  field: 0.25,
  /** Bid at this buyer before, in some other category. */
  knownBuyer: 0.15,
  /**
   * Word overlap with tenders the organization bid on or pursued, for a tender
   * with no CPV code at all. Scaled by the overlap share, so at most 0.25 —
   * under a single exact bid (≈0.37): a guess from text must never outweigh a
   * code the invitation states outright.
   */
  text: 0.25,
  /**
   * The team dropped, or marked no-go, a similar tender. A PENALTY, applied as
   * score × (1 − penalty): it can push a tender into the weak band, and can
   * never take it below zero or out of the list.
   */
  dropped: 0.5,
};

/** How much of a signal survives a weaker CPV match. */
export const CLOSENESS = { exact: 1, group: 0.7, division: 0.4 };

/** A saved-search keyword hit counts like a same-group code: deliberate, but not a code. */
export const KEYWORD_FACTOR = 0.8;

/**
 * How much repeated evidence adds: `w / (w + 0.5)` over the recency-weighted
 * count. One recent lot gives two thirds of a signal, three give 86%; old
 * evidence counts for less without ever counting for nothing.
 */
const volume = (w) => (w > 0 ? w / (w + 0.5) : 0);

const MONTH_MS = 30.44 * 24 * 60 * 60 * 1000;

/**
 * Recency weight, in steps rather than a curve so a ranking can be reproduced
 * by hand: 1 inside `fullMonths`, ½ up to three times that, ¼ beyond — never 0.
 * History is evidence of what a supplier does; age weakens it, nothing erases it.
 * The steps are powers of two on purpose: the ledger index subtracts a
 * candidate's own lots from per-code totals, which is exact only for them.
 */
export const recencyWeight = (at, now, fullMonths) => {
  if (!at) return 0.25;
  const months = Math.max(0, (now.getTime() - new Date(at).getTime()) / MONTH_MS);
  if (months <= fullMonths) return 1;
  if (months <= fullMonths * 3) return 0.5;
  return 0.25;
};

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

/**
 * The signal sources an organization can have, in the order a client should
 * offer them: whether the source is set up at all (`present`), and whether it
 * holds anything to score with (`scorable`). They differ for the supplier
 * identity — claimed, but with no bid in the ledger yet.
 */
const BASIS_SOURCES = [
  {
    name: 'field',
    present: (s) => FIELDS.some((f) => (s.fields ?? []).includes(f.id)),
  },
  {
    name: 'saved_search',
    present: (s) => (s.savedSearches ?? []).length > 0,
  },
  {
    name: 'supplier_identity',
    present: (s) => (s.ledger?.partyIds ?? []).length > 0,
    scorable: (s) => (s.ledger?.items ?? []).length > 0,
  },
  {
    name: 'pipeline',
    present: (s) => (s.pipeline ?? []).length > 0,
    // Only pursuits can lift a tender; a pipeline of nothing but dropped ones
    // can only push down, and there is nothing to push.
    scorable: (s) => (s.pipeline ?? []).some(isPursued),
  },
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
  const missing = BASIS_SOURCES.filter((source) => !source.present(signals)).map((source) => source.name);
  const sufficient = BASIS_SOURCES.some((source) => (source.scorable ?? source.present)(signals));
  return { sufficient, missing };
};

const combine = (strengths) => 1 - strengths.reduce((rest, s) => rest * (1 - s), 1);

const round = (n) => Math.round(n * 10000) / 10000;

/**
 * The units a tender is scored on: one per lot, carrying that lot's codes and
 * the saved-search keywords its item names contain (`keywordHits`, computed by
 * the repository so the names never have to be loaded). The codes the tender
 * states that no lot carries — the primary code, or one the source names
 * without saying which lot it is (armeps.am) — make one unit of their own; a
 * tender with none of either still gets one, so its title can still be read.
 */
const unitsOf = (tender) => {
  const lots = tender.lots ?? [];
  const units = lots.map((lot) => ({ lot: lot.lotNumber, codes: lot.codes ?? [], keywordHits: lot.keywordHits ?? [] }));
  const lotCodes = new Set(units.flatMap((u) => u.codes));
  const unplaced = tenderCodes({ cpvCode: tender.cpvCode, cpvCodes: tender.cpvCodes }).filter((code) => !lotCodes.has(code));
  if (unplaced.length) units.push({ lot: null, codes: unplaced, keywordHits: [] });
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

/** Add one lot to a `[recency-weighted count, raw count]` pair, or take it away. */
const tally = (pair, weight, sign = 1) => {
  pair[0] += sign * weight;
  pair[1] += sign;
};

const merge = (into, [weight, lots]) => {
  into[0] += weight;
  into[1] += lots;
};

const entryOf = (map, key, create) => {
  if (!map.has(key)) map.set(key, create());
  return map.get(key);
};

/**
 * The public bid ledger, indexed for scoring: each lot this organization's
 * supplier identity bid on, with its recency weight. Built once per ranking,
 * never per candidate.
 *
 * Totalled per distinct CPV code, not kept per lot. A heavy supplier has
 * thousands of ledger lots in a handful of codes, and the per-lot lists made a
 * ranking cost candidates × lot codes × ledger lots: ~600 ms at 3,305 lots, and
 * growing with every month of ledger. Codes are bucketed by division so a
 * candidate code is only ever compared with codes that could be close, and
 * `byTender` keeps each tender's own lots so a candidate's can be taken back
 * out — the candidate itself never counts.
 */
const indexLedger = (ledger, now, fullMonths) => {
  const byDivision = new Map();
  const byBuyer = new Map();
  const byTender = new Map();
  for (const item of ledger?.items ?? []) {
    const entry = { ...item, weight: recencyWeight(item.at, now, fullMonths) };
    entryOf(byTender, item.tenderId, () => []).push(entry);
    if (item.cpvCode) {
      const codes = entryOf(byDivision, String(item.cpvCode).slice(0, 2), () => new Map());
      const totals = entryOf(codes, item.cpvCode, () => ({ bid: [0, 0], won: [0, 0], wonAt: new Map() }));
      tally(totals.bid, entry.weight);
      if (item.won) {
        tally(totals.won, entry.weight);
        tally(entryOf(totals.wonAt, item.buyerId, () => [0, 0]), entry.weight);
      }
    }
    if (item.buyerId) {
      const codes = entryOf(byBuyer, item.buyerId, () => new Map());
      const totals = entryOf(codes, item.cpvCode, () => ({ weight: 0, lots: 0, wins: 0 }));
      totals.weight += entry.weight;
      totals.lots += 1;
      if (item.won) totals.wins += 1;
    }
  }
  return { byDivision, byBuyer, byTender, near: new Map() };
};

/**
 * Every ledger lot near one code, per CPV level and cumulative downward — an
 * exact match also counts at group and division level — with the wins among
 * them at one buyer. The same for every candidate carrying that code at that
 * buyer, so it is computed once per ranking; `null` when the code's division
 * holds no ledger lot at all.
 */
const ledgerNear = (ledger, code, buyerId) => {
  const atCode = entryOf(ledger.near, code, () => new Map());
  if (atCode.has(buyerId)) return atCode.get(buyerId);
  const codes = ledger.byDivision.get(String(code).slice(0, 2));
  let near = null;
  if (codes) {
    near = Object.fromEntries(CPV_LEVELS.map((level) => [level, { bid: [0, 0], won: [0, 0], wonSameBuyer: [0, 0] }]));
    for (const [cpvCode, totals] of codes) {
      const level = closeness(code, cpvCode);
      if (level === 'none') continue;
      const wonSameBuyer = totals.wonAt.get(buyerId);
      for (const at of CPV_LEVELS.slice(CPV_LEVELS.indexOf(level))) {
        merge(near[at].bid, totals.bid);
        merge(near[at].won, totals.won);
        if (wonSameBuyer) merge(near[at].wonSameBuyer, wonSameBuyer);
      }
    }
  }
  atCode.set(buyerId, near);
  return near;
};

/**
 * What the ledger says about one unit's category: the strongest of "won here
 * at this buyer", "won here" and "bid here", at whichever CPV closeness gives
 * the most.
 *
 * Evidence accumulates downward — a lot matching exactly also counts at group
 * and division level — so a supplier with one exact bid and ten in the same
 * division is judged on whichever reading is stronger. A loss contributes to
 * "bid here" exactly like a win: competing in a category is relevance, and
 * whether they can win it is the intelligence layer's question. Rejected bids
 * count too — a disqualified submission is still participation, the rule the
 * profile and public-bid repositories already follow. No money is read.
 */
const categorySignal = (tender, unit, ledger) => {
  let best = null;
  const own = ledger.byTender.get(tender.id) ?? [];
  for (const code of unit.codes) {
    const near = ledgerNear(ledger, code, tender.buyerId);
    if (!near) continue;

    // Cumulative weight and raw count per level, for each kind of evidence.
    const sums = Object.fromEntries(CPV_LEVELS.map((level) => [level, {
      bid: [...near[level].bid],
      won: [...near[level].won],
      wonSameBuyer: [...near[level].wonSameBuyer],
    }]));
    // The candidate's own lots come back out. Exact, not approximately so:
    // recency weights are 1, ½ and ¼, which a float adds and subtracts without
    // rounding — a weight off that ladder would need this to sum afresh instead.
    for (const item of own) {
      const level = closeness(code, item.cpvCode);
      if (level === 'none') continue;
      for (const at of CPV_LEVELS.slice(CPV_LEVELS.indexOf(level))) {
        tally(sums[at].bid, item.weight, -1);
        if (item.won) tally(sums[at].won, item.weight, -1);
        if (item.won && item.buyerId === tender.buyerId) tally(sums[at].wonSameBuyer, item.weight, -1);
      }
    }

    for (const level of CPV_LEVELS) {
      for (const kind of ['wonSameBuyer', 'won', 'bid']) {
        const [weight, lots] = sums[level][kind];
        const strength = WEIGHTS[kind] * CLOSENESS[level] * volume(weight);
        if (strength > 0 && (!best || strength > best.strength)) {
          best = {
            strength,
            reason: {
              code: kind === 'bid' ? 'bid_category' : 'won_category',
              level,
              cpvCode: code,
              lots,
              sameBuyer: kind === 'wonSameBuyer',
              lot: unit.lot,
            },
          };
        }
      }
    }
  }
  return best;
};

/**
 * Pursued or turned down. Dropping a pursuit, or marking it no-go, is the team
 * saying "not for us"; every other state — including `lost`, which is having
 * competed — is the team saying "this is our kind of work".
 */
export const isPursued = (item) => item.status !== 'dropped' && item.goNoGo !== 'no_go';

/** The pipeline, aged and split into the two directions it pushes. */
const indexPipeline = (pipeline, now, fullMonths) => {
  const pursued = [];
  const dropped = [];
  const tracking = new Map();
  for (const item of pipeline ?? []) {
    tracking.set(item.tenderId, { trackedTenderId: item.trackedTenderId, status: item.status, goNoGo: item.goNoGo ?? null });
    if (!item.codes?.length) continue;
    const entry = { ...item, weight: recencyWeight(item.at, now, fullMonths) };
    (isPursued(item) ? pursued : dropped).push(entry);
  }
  return { pursued, dropped, tracking };
};

/**
 * How strongly a unit resembles a set of the team's pursuits: per CPV level,
 * the recency-weighted count of tenders with a code that close, cumulative
 * downward like the ledger. The candidate itself never counts — a tracked
 * tender sits at its natural position, unboosted, or the list would only tell
 * the team what it already knows.
 */
const resemblance = (tender, unit, items, weight, code) => {
  let best = null;
  for (const cpvCode of unit.codes) {
    const sums = Object.fromEntries(CPV_LEVELS.map((level) => [level, [0, 0]]));
    for (const item of items) {
      if (item.tenderId === tender.id) continue;
      const match = bestCpvMatch([cpvCode], item.codes);
      if (match.level === 'none') continue;
      for (const at of CPV_LEVELS.slice(CPV_LEVELS.indexOf(match.level))) {
        sums[at][0] += item.weight;
        sums[at][1] += 1;
      }
    }
    for (const level of CPV_LEVELS) {
      const [w, tenders] = sums[level];
      const strength = weight * CLOSENESS[level] * volume(w);
      if (strength > 0 && (!best || strength > best.strength)) {
        best = { strength, reason: { code, level, cpvCode, tenders, lot: unit.lot } };
      }
    }
  }
  return best;
};

/**
 * A buyer this supplier has bid at before, in ANOTHER category: a relationship
 * already built counts for a little. Only lots no closer than a different
 * division to this unit count — a same-category lot at this buyer is already
 * evidence for the category signal, and counting it here too would score one
 * bid twice.
 */
const knownBuyerSignal = (tender, unit, ledger) => {
  const atBuyer = tender.buyerId ? ledger.byBuyer.get(tender.buyerId) : null;
  if (!atBuyer) return [];
  const elsewhere = (cpvCode) => unit.codes.every((code) => closeness(code, cpvCode) === 'none');
  let weight = 0;
  let lots = 0;
  let wins = 0;
  for (const [cpvCode, totals] of atBuyer) {
    if (!elsewhere(cpvCode)) continue;
    weight += totals.weight;
    lots += totals.lots;
    wins += totals.wins;
  }
  // The candidate's own lots never count; exact for the reason categorySignal gives.
  for (const item of ledger.byTender.get(tender.id) ?? []) {
    if (item.buyerId !== tender.buyerId || !elsewhere(item.cpvCode)) continue;
    weight -= item.weight;
    lots -= 1;
    if (item.won) wins -= 1;
  }
  if (!lots) return [];
  return [{
    strength: WEIGHTS.knownBuyer * volume(weight),
    reason: { code: 'known_buyer', lots, wins },
  }];
};

export const hasAnyCode = (tender) =>
  tenderCodes({ cpvCode: tender.cpvCode, cpvCodes: tender.cpvCodes, lotCodes: (tender.lots ?? []).flatMap((lot) => lot.codes ?? []) }).length > 0;

/** What a tender is about, in words: the title, plus lot names when loaded. Never the reference code — it names a procedure, not a purchase. */
const textOf = (tender) => tender.text ?? tender.title ?? '';

/**
 * Word rarity for this ranking, prepared once: only when some candidate has no
 * code to rank on and there is a profile to compare it with. The corpus is every
 * candidate plus the profile documents, so boilerplate common to this week's
 * tenders weighs nothing.
 */
const prepareText = (candidates, profile) => {
  if (!profile?.length || candidates.every(hasAnyCode)) return null;
  const profileDocs = profile.map(termsOf);
  const candidateDocs = new Map(candidates.map((t) => [t.id, termsOf(textOf(t))]));
  return {
    rarity: buildRarity([...candidateDocs.values(), ...profileDocs]),
    candidateDocs,
    profile: buildProfile(profileDocs),
  };
};

/**
 * The fallback for a tender with no CPV code anywhere: how much of its
 * distinctive vocabulary the organization's own tenders share. Its reason is a
 * code of its own so a client can word it more tentatively than a code match.
 */
const textSignal = (tender, text) => {
  if (!text || hasAnyCode(tender)) return [];
  const { share, terms } = overlap(text.candidateDocs.get(tender.id), text.profile, text.rarity);
  if (share <= 0) return [];
  return [{
    strength: WEIGHTS.text * share,
    reason: { code: 'text_overlap', terms: terms.slice(0, 3), share: Math.round(share * 100) / 100, lot: null },
  }];
};

/** One tender, all its units scored, the best one kept. */
const scoreTender = (tender, signals, context) => {
  let best = null;
  for (const unit of unitsOf(tender)) {
    const category = categorySignal(tender, unit, context.ledger);
    const pursued = resemblance(tender, unit, context.pipeline.pursued, WEIGHTS.pursued, 'pursued_similar');
    const positives = [
      ...(category ? [category] : []),
      ...(pursued ? [pursued] : []),
      ...knownBuyerSignal(tender, unit, context.ledger),
      ...savedSearchSignal(tender, unit, signals.savedSearches ?? []),
      ...fieldSignal(unit, signals.fields ?? []),
      ...textSignal(tender, context.text),
    ];
    const lifted = combine(positives.map((p) => p.strength));

    // A demotion is only named when there was something to demote.
    const dropped = lifted > 0
      ? resemblance(tender, unit, context.pipeline.dropped, WEIGHTS.dropped, 'dropped_similar')
      : null;
    const score = lifted * (1 - (dropped?.strength ?? 0));

    if (!best || score > best.score) {
      best = {
        score,
        reasons: [
          ...positives.sort((a, b) => b.strength - a.strength).map((p) => p.reason),
          ...(dropped ? [dropped.reason] : []),
        ],
      };
    }
  }
  const score = round(best.score);
  return {
    score,
    band: bandOf(score),
    reasons: best.reasons,
    tracking: context.pipeline.tracking.get(tender.id) ?? null,
  };
};

/**
 * The full sort key: score descending, then the tender closing soonest, with no
 * deadline last, then id. The cursor encodes all three, so paging through a
 * ranking computed per request neither repeats nor skips a row.
 */
export const compareRanked = (a, b) => {
  if (a.score !== b.score) return b.score - a.score;
  const closesA = a.deadlineAt ? new Date(a.deadlineAt).getTime() : Number.POSITIVE_INFINITY;
  const closesB = b.deadlineAt ? new Date(b.deadlineAt).getTime() : Number.POSITIVE_INFINITY;
  if (closesA !== closesB) return closesA - closesB;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Rank candidate tenders for one organization.
 *
 * @param {Array}  candidates  `{ id, title, referenceCode, cpvCode, cpvCodes, buyerId, estimatedValue, deadlineAt, lots: [{ lotNumber, codes, keywordHits }] }`
 * @param {object} signals     `{ fields, savedSearches, ledger: { partyIds, items: [{ tenderId, cpvCode, buyerId, at, won }] },
 *                             pipeline: [{ trackedTenderId, tenderId, status, goNoGo, at, codes }],
 *                             textProfile: [string] — titles and lot names of tenders bid on or pursued;
 *                             needed only when a candidate has no code, and its `text` then too }`
 * @param {object} options     `{ now, recencyMonths }` — the clock every signal ages against, and
 *                             the full-weight window; both explicit so a backtest can replay a past day
 * @returns {Array} `{ tender, id, deadlineAt, score, band, reasons, tracking }`, best first
 */
export const rankTenders = (candidates, signals, { now, recencyMonths } = {}) => {
  if (!(now instanceof Date)) throw new Error('rankTenders needs an explicit `now`');
  if (!Number.isFinite(recencyMonths) || recencyMonths <= 0) throw new Error('rankTenders needs `recencyMonths`');
  const context = {
    ledger: indexLedger(signals.ledger, now, recencyMonths),
    pipeline: indexPipeline(signals.pipeline, now, recencyMonths),
    text: prepareText(candidates, signals.textProfile),
  };
  return candidates
    .map((tender) => ({ tender, id: tender.id, deadlineAt: tender.deadlineAt ?? null, ...scoreTender(tender, signals, context) }))
    .sort(compareRanked);
};

export default { WEIGHTS, CLOSENESS, BANDS, bandOf, basisOf, recencyWeight, rankTenders, compareRanked };
