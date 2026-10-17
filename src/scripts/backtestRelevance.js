import { closeDb } from '../libs/knex.js';
import tenders from '../repositories/tender.repo.js';
import relevance from '../repositories/relevance.repo.js';
import { rankTenders, WEIGHTS, CLOSENESS, BANDS } from '../services/relevance.service.js';

/**
 * Would the relevant list have put a supplier's real bids near the top?
 *
 * A backtest against the public ledger, which records what hundreds of real
 * suppliers bid on. Pick a cut-off date. For every supplier that bid on a
 * tender that was biddable on that date, rank those tenders using only the
 * supplier's ledger history from BEFORE the cut-off, and see where the tenders
 * they really bid on landed.
 *
 * It calls the production `rankTenders` unchanged — a second copy of the rule
 * would measure something that is not shipped. Only ledger history is replayed:
 * suppliers in the ledger are not customers, so they have no saved searches,
 * fields or pipeline. That makes this a test of the ledger signals (and the
 * text fallback riding on them), which are the ones that carry weight.
 *
 * Positions are tie-aware. Tenders with equal scores — most often a block of
 * zeroes — are ordered by deadline in production, which says nothing about fit,
 * so a bid inside a tie is placed at the tie's middle rather than wherever the
 * deadline happened to put it. Each figure is shown beside what a random order
 * would score, because "top 10 of 150" means nothing without it.
 *
 * Run by hand; prints numbers; asserts nothing. Not a test.
 *
 * Usage:
 *   node src/scripts/backtestRelevance.js [--cutoff=2026-08-15] [--months=6,12,24] [--min-history=3]
 *
 *   --cutoff       the replay date; default: the median auction date in the ledger
 *   --months       full-weight windows to sweep (RELEVANCE_FULL_WEIGHT_MONTHS)
 *   --min-history  ledger lots before the cut-off for a supplier to count as
 *                  rankable; those below are reported separately, never averaged in
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
  })
);

const monthsSwept = String(args.months ?? '6,12,24').split(',').map(Number).filter((n) => n > 0);
const minHistory = args['min-history'] ? Number(args['min-history']) : 3;

/** The candidate shape `rankTenders` reads, as the relevant list builds it. */
const candidateOf = (row) => ({
  id: row.id,
  title: row.title,
  referenceCode: row.reference_code,
  cpvCode: row.cpv_code,
  buyerId: row.buyer_id,
  estimatedValue: row.estimated_value === null ? null : Number(row.estimated_value),
  deadlineAt: row.deadline_at,
  lots: (row.lots ?? []).map((l) => ({ lotNumber: l.lot_number, codes: l.codes ?? [], keywordHits: [] })),
});

/** 1-based position of each target, a tie placed at the middle of its tie. */
const positionsOf = (ranked, targets) => {
  const positions = [];
  for (const id of targets) {
    const score = ranked.find((r) => r.id === id)?.score;
    if (score === undefined) continue;
    const above = ranked.filter((r) => r.score > score).length;
    const tied = ranked.filter((r) => r.score === score).length;
    positions.push(above + (tied + 1) / 2);
  }
  return positions;
};

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const pct = (n) => (n === null ? '—' : `${(n * 100).toFixed(1)}%`);

/** Aggregate one group of suppliers' results into the figures the report prints. */
const summarise = (results, n) => {
  const positions = results.flatMap((r) => r.positions);
  if (!positions.length) return null;
  const share = (k) => positions.filter((p) => p <= k).length / positions.length;
  return {
    suppliers: results.length,
    bids: positions.length,
    top10: share(10),
    top20: share(20),
    medianPercentile: median(positions.map((p) => p / n)),
    // Mean over suppliers of 1 / the position of their best-placed real bid.
    mrr: results.reduce((sum, r) => sum + 1 / Math.min(...r.positions), 0) / results.length,
    // What a random order would have scored on the same targets.
    random10: Math.min(1, 10 / n),
    random20: Math.min(1, 20 / n),
  };
};

const run = async () => {
  const cutoff = args.cutoff ? new Date(args.cutoff) : await relevance.medianLedgerDate();
  if (!cutoff || Number.isNaN(cutoff.getTime())) throw new Error('no usable cut-off date');

  const rows = await tenders.findBiddableAsOf(cutoff);
  const candidates = rows.map(candidateOf);
  const candidateIds = new Set(candidates.map((c) => c.id));

  // Who really bid on what was biddable at the cut-off: the targets.
  const targetsByParty = await relevance.biddersOn([...candidateIds]);
  const partyIds = [...targetsByParty.keys()];
  const histories = await relevance.ledgerFor(partyIds, { before: cutoff });

  // The text fallback reads titles: load them once for every tender involved.
  const uncoded = candidates.filter((c) => !c.cpvCode && !c.lots.some((l) => l.codes.length));
  const historyIds = new Set([...histories.values()].flat().map((i) => i.tenderId));
  const texts = uncoded.length ? await relevance.textFor([...uncoded.map((c) => c.id), ...historyIds]) : new Map();
  const ranked = candidates.map((c) => (texts.has(c.id) && uncoded.includes(c) ? { ...c, text: texts.get(c.id) } : c));

  const n = candidates.length;
  console.log(`cut-off ${cutoff.toISOString()} — ${n} tenders biddable, ${uncoded.length} with no CPV`);
  console.log(`${partyIds.length} suppliers bid on at least one of them`);
  console.log(`weights ${JSON.stringify(WEIGHTS)}`);
  console.log(`closeness ${JSON.stringify(CLOSENESS)}  bands ${JSON.stringify(BANDS)}\n`);

  const history = partyIds.map((id) => histories.get(id).length).sort((a, b) => a - b);
  console.log(
    `ledger lots before the cut-off, per supplier: median ${median(history)}, ` +
      `${history.filter((h) => h >= minHistory).length} with ≥ ${minHistory}, ${history.filter((h) => h === 0).length} with none\n`
  );

  for (const months of monthsSwept) {
    const groups = { rankable: [], thin: [] };
    for (const partyId of partyIds) {
      const items = histories.get(partyId);
      const signals = {
        fields: [],
        savedSearches: [],
        pipeline: [],
        ledger: { partyId, items },
        textProfile: [...new Set(items.map((i) => i.tenderId))].map((id) => texts.get(id)).filter(Boolean),
      };
      const order = rankTenders(ranked, signals, { now: cutoff, recencyMonths: months });
      const positions = positionsOf(order, targetsByParty.get(partyId));
      if (!positions.length) continue;
      groups[items.length >= minHistory ? 'rankable' : 'thin'].push({ partyId, positions });
    }

    console.log(`— full weight ${months} months —`);
    for (const [name, results] of Object.entries(groups)) {
      const s = summarise(results, n);
      if (!s) {
        console.log(`  ${name.padEnd(9)} no suppliers`);
        continue;
      }
      console.log(
        `  ${name.padEnd(9)} ${String(s.suppliers).padStart(4)} suppliers, ${String(s.bids).padStart(4)} real bids | ` +
          `top 10 ${pct(s.top10)} (random ${pct(s.random10)}) | top 20 ${pct(s.top20)} (random ${pct(s.random20)}) | ` +
          `median position ${pct(s.medianPercentile)} of the list (random 50%) | MRR ${s.mrr.toFixed(3)}`
      );
    }
    console.log('');
  }
};

run()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(`[backtest] ${error.stack ?? error.message}`);
    await closeDb();
    process.exit(1);
  });
