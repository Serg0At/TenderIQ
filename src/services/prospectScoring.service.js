/**
 * ICP scoring for founder-led sales prospecting.
 *
 * Pure business logic — no Knex, no `db` import (see the hard boundary in
 * CLAUDE.md: only repositories touch the database). Consumes the raw rows
 * from src/repositories/prospects.repo.js.
 *
 * Model source: docs/business/Target Customers.md, Sales Strategy.md,
 * Pricing Strategy.md (../CRM/gov-tender-monitoring). Every threshold below
 * is traceable to a line in one of those docs — see the comment next to it.
 * Nothing here is tuned from intuition; if a number looks arbitrary, that's
 * a gap to go re-check against the docs, not a free parameter.
 */

// --- Vertical classification ---------------------------------------------
//
// Target Customers.md is explicit: "Vertical must be inferred from what
// they actually bid on (tender subject/category), never from the company
// name." Inputs are ARMEPS tender titles + goods_works_services labels
// (Armenian, sometimes Russian) sampled from the supplier's own bid history
// — never the supplier's own name.
//
// cpv_code is always null in the live schema today (never parsed — see
// mapArmepsDetail in workers/normalizer.js, which sets cpvCode: null because
// the code lives only inside the invitation ZIP), so this is keyword matching
// over free text, not real CPV classification. That is a materially weaker
// signal than CPV would be and should be replaced once CPV parsing exists;
// treat `vertical` below as a best-effort label, not a fact.

const VERTICAL_KEYWORDS = {
  construction: {
    priority: 'P0',
    keywords: [
      'շինարար', 'շին', 'վերանորոգ', 'ասֆալտ', 'ճանապարհ', 'շենք', 'կառուցում',
      'ремонт', 'строит', 'дорож', 'реконструкц',
    ],
  },
  it: {
    priority: 'P0',
    keywords: [
      'համակարգիչ', 'ծրագրային', 'ինֆորմացիոն', 'ցանց', 'սերվեր', 'ՏՏ',
      'компьютер', 'программ', 'сервер', 'сеть', 'ит-',
    ],
  },
  medical: {
    priority: 'P0',
    keywords: [
      'բժշկ', 'բուժ', 'հիվանդանոց', 'պոլիկլինիկ', 'բժշկական սարքավորում',
      'медицин', 'больниц', 'клиник',
    ],
  },
  pharma_equipment: {
    priority: 'P1',
    keywords: [
      'դեղ', 'դեղագործ', 'սարքավորում', 'լաբորատոր',
      'фармацевт', 'лаборатор', 'оборудован',
    ],
  },
  consultants: {
    priority: 'P1',
    keywords: ['խորհրդատվ', 'консалт', 'консульт'],
  },
  food: {
    priority: 'P2',
    keywords: [
      'պարեն', 'սննդ', 'մթերք',
      'продукт', 'питани', 'продовольств',
    ],
  },
};

const PRIORITY_WEIGHT = { P0: 1, P1: 0.7, P2: 0.4, P3: 0.15 };

/**
 * @param {string[]} sampledTenders `"title::goodsWorksServices"` pairs, as
 *   returned by prospects.repo.js `listProspectCandidates`.
 */
const countVerticalHits = (sampledTenders = []) => {
  const haystack = sampledTenders.join(' \n ').toLowerCase();
  const hitCounts = {};

  for (const [vertical, { keywords }] of Object.entries(VERTICAL_KEYWORDS)) {
    hitCounts[vertical] = keywords.reduce(
      (count, kw) => count + (haystack.includes(kw.toLowerCase()) ? 1 : 0),
      0
    );
  }

  return hitCounts;
};

/**
 * Up to `topN` verticals this supplier's bid history actually matches
 * keywords for, ranked by hit count — the "top 3 categories" column in the
 * export. Distinct from `inferVertical`, which collapses to a single label
 * for scoring; a supplier can legitimately straddle two verticals here.
 */
export const getTopCategories = (sampledTenders = [], topN = 3) =>
  Object.entries(countVerticalHits(sampledTenders))
    .filter(([, hits]) => hits > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([vertical]) => vertical);

export const inferVertical = (sampledTenders = []) => {
  const hitCounts = countVerticalHits(sampledTenders);
  const [bestVertical, bestHits] = Object.entries(hitCounts).sort((a, b) => b[1] - a[1])[0];

  if (bestHits === 0) {
    // Target Customers.md: "Small/infrequent bidders ... explicitly
    // deprioritized" and everything not in a named vertical defaults there.
    return { vertical: 'other_small_infrequent', priority: 'P3', confidence: 0 };
  }

  return {
    vertical: bestVertical,
    priority: VERTICAL_KEYWORDS[bestVertical].priority,
    confidence: Number((bestHits / Math.max(sampledTenders.length, 1)).toFixed(2)),
  };
};

// --- ICP score --------------------------------------------------------
//
// Inputs, in the priority order fixed by Target Customers.md /
// Sales Strategy.md: (1) bid frequency — "bids at least monthly" is the
// core qualifier; (2) contract value density — "one win must dwarf the
// subscription"; (3) vertical; (4) recency — active in the last 90 days;
// (5) loss rate / near-misses — "a frequent loser is the hottest prospect."
//
// Weights below sum to 1.0 and reflect that stated priority order. They are
// a starting model, not a validated one — Target Customers.md's own Risk
// section says WTP-per-vertical needs validating with real suppliers; treat
// these weights the same way.

const WEIGHTS = {
  frequency: 0.35,
  valueDensity: 0.25,
  vertical: 0.2,
  recency: 0.1,
  lossSignal: 0.1,
};

const RECENCY_WINDOW_DAYS = 90; // Target Customers.md: "recency (active in the last 90 days)"
const MIN_BIDS_FOR_SCORE = 3; // below this, "monthly bidder" cannot be claimed honestly
const MIN_MONTHS_FOR_SCORE = 2; // need at least 2 months of history to compute a monthly rate at all

/**
 * Highest tier a Pro subscription needs to beat to satisfy Sales Strategy.md's
 * "one extra win pays for a year" framing. $1,200/yr is the Pro example in
 * Pricing Strategy.md; used only to normalize value density into a 0..1
 * score, not to price anything.
 */
const REFERENCE_ANNUAL_SUBSCRIPTION_USD = 1200;

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * @param {object} candidate one row from prospects.repo.js `listProspectCandidates`
 * @param {{ amdToUsd?: number, nowMs?: number }} [opts] amdToUsd: AMD-per-USD
 *   rate; total_final_value etc. are in AMD (see tenders.currency). No
 *   default is supplied on purpose — passing a stale hardcoded FX rate would
 *   silently corrupt every value-density score. The caller must pass a rate
 *   sourced from an actual FX lookup, or value density is left unscored.
 */
export const scoreCandidate = (candidate, { amdToUsd, nowMs = Date.now() } = {}) => {
  const bidCount = Number(candidate.bid_count ?? 0);

  /**
   * PROXY, not a measurement. ARMEPS never publishes when a bid was submitted,
   * so activity span is derived from the *tender's* publish dates. A supplier
   * whose sampled tenders all happened to be published in one week therefore
   * reads as a burst regardless of how it actually paced its bidding, which is
   * part of why the result below is gated behind insufficient_data rather than
   * presented as a measured cadence.
   */
  const firstActivityAt = candidate.first_tender_published_at
    ? new Date(candidate.first_tender_published_at)
    : null;
  const lastActivityAt = candidate.last_tender_published_at
    ? new Date(candidate.last_tender_published_at)
    : null;

  if (bidCount < MIN_BIDS_FOR_SCORE || !firstActivityAt || !lastActivityAt) {
    return insufficientData(candidate, 'fewer than 3 sampled bids in the lookback window');
  }

  const monthsActive = Math.max(
    (lastActivityAt.getTime() - firstActivityAt.getTime()) / (1000 * 60 * 60 * 24 * 30),
    1 / 30 // clamp so a single-day burst of bids doesn't divide by ~0
  );
  if (monthsActive < MIN_MONTHS_FOR_SCORE) {
    return insufficientData(candidate, 'less than 2 months of bidding history — cannot compute a monthly rate');
  }

  const bidsPerMonth = bidCount / monthsActive;
  // "bids at least monthly" ≈ 1/mo → 1.0; scale so 2+/mo saturates rather
  // than rewarding pure volume unboundedly.
  const frequencyScore = clamp01(bidsPerMonth / 2);

  let valueDensityScore = null;
  if (amdToUsd && candidate.median_final_value != null) {
    const medianUsd = Number(candidate.median_final_value) / amdToUsd;
    // "one win must dwarf the subscription" — score saturates once the
    // median win is ~5x the reference annual subscription.
    valueDensityScore = clamp01(medianUsd / (REFERENCE_ANNUAL_SUBSCRIPTION_USD * 5));
  }

  const sampleText = (candidate.sampled_tenders ?? []).map((row) => row.replace('::', ' '));
  const { vertical, priority, confidence } = inferVertical(sampleText);
  const topCategories = getTopCategories(sampleText, 3);
  const verticalScore = PRIORITY_WEIGHT[priority] ?? PRIORITY_WEIGHT.P3;

  const daysSinceLastBid = (nowMs - lastActivityAt.getTime()) / (1000 * 60 * 60 * 24);
  const recencyScore = daysSinceLastBid <= RECENCY_WINDOW_DAYS
    ? 1
    : clamp01(1 - (daysSinceLastBid - RECENCY_WINDOW_DAYS) / 180);

  const totalDecided = Number(candidate.win_count ?? 0) + Number(candidate.loss_count ?? 0);
  // "a frequent loser is the hottest prospect" — a high loss count among
  // several decided lots is a POSITIVE signal here (proof-sheet fodder,
  // proven bidder), not a negative one. A candidate with zero losses and
  // zero wins (nothing decided yet) scores neutral, not zero.
  const lossSignalScore = totalDecided === 0
    ? 0.5
    : clamp01(Number(candidate.loss_count ?? 0) / totalDecided);

  // If value density couldn't be computed (no FX rate given), redistribute
  // its weight across the remaining components rather than silently
  // scoring it 0 — a missing FX rate must not look like "this company has
  // no valuable contracts."
  const components = valueDensityScore === null
    ? { frequency: frequencyScore, vertical: verticalScore, recency: recencyScore, lossSignal: lossSignalScore }
    : { frequency: frequencyScore, valueDensity: valueDensityScore, vertical: verticalScore, recency: recencyScore, lossSignal: lossSignalScore };

  const activeWeights = Object.fromEntries(Object.keys(components).map((k) => [k, WEIGHTS[k]]));
  const weightSum = Object.values(activeWeights).reduce((a, b) => a + b, 0);

  const icpScore = Object.entries(components).reduce(
    (sum, [key, value]) => sum + value * (activeWeights[key] / weightSum),
    0
  );

  return {
    supplierId: candidate.supplier_id,
    supplierName: candidate.supplier_name,
    taxId: candidate.tax_id ?? null,
    bidCount,
    tenderCount: candidate.tender_count,
    winCount: candidate.win_count,
    lossCount: candidate.loss_count,
    bidsPerMonth: Number(bidsPerMonth.toFixed(2)),
    lastActivityAt: candidate.last_tender_published_at,
    vertical,
    verticalConfidence: confidence,
    topCategories,
    priorityTier: priority,
    icpScore: Number((icpScore * 100).toFixed(1)), // 0..100 for readability
    suggestedTier: suggestPricingTier({ bidsPerMonth, candidate, valueDensityScore }),
    insufficientData: false,
    scoreBreakdown: Object.fromEntries(
      Object.entries(components).map(([k, v]) => [k, Number(v.toFixed(2))])
    ),
  };
};

const insufficientData = (candidate, reason) => ({
  supplierId: candidate.supplier_id,
  supplierName: candidate.supplier_name,
  taxId: candidate.tax_id ?? null,
  icpScore: null,
  suggestedTier: null,
  insufficientData: true,
  reason,
});

// --- Pricing tier -------------------------------------------------------
//
// Pricing Strategy.md tiers scale "by bidding activity and seats." We only
// ever observe activity (bid frequency + value), never seats/headcount, so
// Team is a proxy at best, and Consultant is NOT assignable from bid data
// at all — a consultancy bids under each CLIENT's name, not its own, so it
// never appears as a `parties.role = 'supplier'` bidder in this data. Any
// Consultant-tier prospect has to come from a separate channel-identification
// pass (see docs/PROSPECT_FEASIBILITY.md), not this scorer.

export const suggestPricingTier = ({ bidsPerMonth, candidate, valueDensityScore }) => {
  const highValue = valueDensityScore !== null && valueDensityScore >= 0.6;
  const tenderCount = Number(candidate.tender_count ?? 0);

  if (bidsPerMonth >= 1 && highValue && tenderCount >= 8) {
    // High frequency AND high value AND breadth of concurrent tenders is
    // the closest bid-data proxy for "larger firm w/ bid team" in
    // Target Customers.md — Team tier in Pricing Strategy.md.
    return 'Team';
  }
  if (bidsPerMonth >= 1) {
    // Pricing Strategy.md: Pro = "P0 frequent bidders"; Target Customers.md's
    // qualifying bar is explicitly "bids at least monthly."
    return 'Pro';
  }
  return 'Starter';
};

export default { inferVertical, getTopCategories, scoreCandidate, suggestPricingTier };
