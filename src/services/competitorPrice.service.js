import config from '../configs/variables.config.js';
import bids from '../repositories/publicBid.repo.js';

const { INTELLIGENCE } = config;

/**
 * Competitor winning prices — "who won each lot of this tender, at what price,
 * against how many bidders".
 *
 * The headline of the intelligence section, and the one part of it that needs
 * no CPV code: it reads `awards`, `public_tender_bids` and `parties` for a
 * single tender, all of which are keyed by tender id. That matters, because CPV
 * is populated for roughly a third of the corpus and every category-based
 * feature is blocked behind that backlog. This one is not.
 *
 * It is a RECORD, not a statistic. A benchmark can be too thin to report and
 * must then say `insufficient_data`; a bid ledger with three rows in it is
 * simply three bids, and reporting them is neither a guess nor an
 * extrapolation. So the honest-intelligence rule applies here in a different
 * shape: never present a lot as uncontested when what actually happened is that
 * the ledger was not scraped. `status` distinguishes the two.
 *
 * Everything reported is published public record from the source's own results
 * page. Nothing tenant-private is read, and nothing is inferred about why a
 * buyer chose whom it chose.
 */

/**
 * Competition bands, cut against the real distribution of the corpus:
 * 32% of lots draw one bidder, 35% draw two or three, 22% four to six, 11%
 * seven or more. So each band is a meaningfully different market, not an
 * arbitrary split of a range.
 *
 * These are descriptions of a lot, never a judgement about the buyer. A
 * one-bidder lot is labelled `sole`, which is a fact; it is not labelled
 * suspicious, wired, or restrictive, none of which this data can establish.
 */
const band = (bidderCount) => {
  if (!bidderCount) return 'none';
  if (bidderCount === 1) return 'sole';
  if (bidderCount <= 3) return 'low';
  if (bidderCount <= 6) return 'moderate';
  return 'high';
};

/**
 * Percent below the buyer's published budget. Takes the price WITH VAT, because
 * the budget includes it and the source checks bids against it gross. Null
 * rather than zero when there is no budget to compare against — a missing
 * figure is not a 0% discount, and
 * averaging those in is how a discount statistic quietly becomes meaningless.
 */
const discountPct = (price, budget) => {
  const p = Number(price);
  const b = Number(budget);
  if (!Number.isFinite(p) || !Number.isFinite(b) || b <= 0) return null;
  return Math.round(((b - p) / b) * 1000) / 10;
};

/**
 * Percent above the winning price. 0 for the winner itself. Takes prices
 * WITHOUT VAT: the auction ranks on them, and on the gross figure a VAT-paying
 * winner reads up to 20% dearer than a non-payer it beat.
 */
const gapPct = (price, winning) => {
  const p = Number(price);
  const w = Number(winning);
  if (!Number.isFinite(p) || !Number.isFinite(w) || w <= 0) return null;
  return Math.round(((p - w) / w) * 1000) / 10;
};

const num = (value) => (value === null || value === undefined ? null : Number(value));

/**
 * The opening bid, or null when the scraped value contradicts the source's own
 * rule.
 *
 * A bid cannot exceed the buyer's published budget — and `final_offer_price`
 * never does: 0 of 35,503 accepted bids in the corpus break it. But
 * `initial_offer_price` breaks it in 9,085 of them (25.6%), and 7.2% of
 * opening bids are 50x or more of the same bidder's final price. One winner's
 * ledger reads 1,080,000,000 opening against a 20,403,350 budget for a lot it
 * took at 10,780,200.
 *
 * So this is a parse artifact in the opening-price column, not an auction
 * behaviour, and the source supplies its own test for it. Returning null with
 * the reason attached is the honest handling: the figure is not silently
 * dropped, not silently corrected, and not passed downstream where the AI layer
 * or a price statistic could treat it as evidence. `final_offer_price` — the
 * column everything actually prices against — is unaffected.
 *
 * The raw payloads are kept forever, so a fixed parser can replay these from
 * storage without re-crawling.
 */
const openingOffer = (initial, budget) => {
  const i = num(initial);
  const b = num(budget);
  if (i === null) return { value: null, unreliable: false };
  if (b > 0 && i > b) return { value: null, unreliable: true };
  return { value: i, unreliable: false };
};

/**
 * How competition is resolved when the tender's own ledger is not the answer —
 * widening in the same staged way benchmarks do, most specific first, and
 * returning the tier used so the caller knows how strong the claim is.
 *
 * Tier 4 exists because CPV is missing on most of the corpus. Without it, a
 * tender with no category would fall straight to a corpus-wide average, when
 * "this particular buyer typically draws 2 bidders" is both available and far
 * more useful.
 */
const COMPETITION_TIERS = [
  { basis: 'buyer_exact_cpv', needsCpv: true, exact: true, useBuyer: true },
  { basis: 'exact_cpv', needsCpv: true, exact: true, useBuyer: false },
  { basis: 'cpv_family', needsCpv: true, exact: false, useBuyer: false },
  { basis: 'buyer_all_categories', needsCpv: false, exact: true, useBuyer: true },
  { basis: 'corpus', needsCpv: false, exact: true, useBuyer: false },
];

export default class CompetitorPriceService {
  /**
   * How many bidders to expect on a lot like this one.
   *
   * Deliberately usable on a tender that has NOT settled — which is the only
   * kind a supplier can still act on. A retrospective ledger tells you what
   * happened; this tells you what you are about to walk into.
   */
  static async expectedCompetition({
    cpvCode = null,
    buyerId = null,
    sinceMonths = INTELLIGENCE.RECENCY_MONTHS,
  } = {}) {
    let widest = null;

    for (const tier of COMPETITION_TIERS) {
      if (tier.needsCpv && !cpvCode) continue;
      if (tier.useBuyer && !buyerId) continue;

      const stats = await bids.expectedCompetition({
        cpvCode: tier.needsCpv ? cpvCode : null,
        exact: tier.exact,
        buyerId: tier.useBuyer ? buyerId : null,
        sinceMonths,
      });

      widest = { ...stats, basis: tier.basis };
      if (stats.sampleLots >= INTELLIGENCE.MIN_COMPARABLES) {
        return {
          status: 'ok',
          ...stats,
          // The share of comparable lots that drew exactly one bidder. Stated
          // as a rate rather than a flag: it tells a supplier how often this
          // market goes uncontested, which is a pricing input.
          soleBidderRatePct:
            stats.sampleLots > 0
              ? Math.round((stats.soleBidderLots / stats.sampleLots) * 1000) / 10
              : null,
          basis: tier.basis,
          sinceMonths,
        };
      }
    }

    return {
      status: 'insufficient_data',
      reason: `fewer than ${INTELLIGENCE.MIN_COMPARABLES} comparable lots`,
      sampleLots: widest?.sampleLots ?? 0,
      required: INTELLIGENCE.MIN_COMPARABLES,
      basis: widest?.basis ?? null,
    };
  }

  /**
   * The full competitor-price picture for one tender.
   *
   * `tender` is the row from `TenderRepository.findDetail` — passed in rather
   * than re-fetched so the controller resolves existence (and returns 404)
   * exactly once.
   */
  static async forTender(tender, { lot = null, includeRejected = true } = {}) {
    const [ledger, awards, lotRows] = await Promise.all([
      bids.ledgerForTender(tender.id),
      bids.awardsForTender(tender.id),
      bids.lotsForTender(tender.id),
    ]);

    // A tender's headline code, or the first lot that carries one. Same rule
    // the benchmark panel uses, so the two agree about what this tender is.
    const cpvCode =
      tender.cpv_code ?? tender.lots?.find((l) => l.cpv_code)?.cpv_code ?? null;

    const expected = await CompetitorPriceService.expectedCompetition({
      cpvCode,
      buyerId: tender.buyer_id,
    });

    if (!ledger.length) {
      return {
        // Not `insufficient_data`: nothing here is too thin to compute. The
        // ledger only appears once a tender settles, so the honest answer is
        // that there is no public bid record YET — a live tender and a
        // scraping gap must not be reported as "no competitors".
        status: 'no_public_bids',
        reason:
          'No public bid ledger for this tender. The source publishes one only after the auction settles.',
        tenderId: tender.id,
        settled: false,
        expectedCompetition: expected,
        lots: [],
      };
    }

    const awardByLot = new Map(awards.map((a) => [a.lot_number, a]));
    const statsByLot = new Map(lotRows.map((l) => [l.lot_number, l]));

    const lotNumbers = [...statsByLot.keys()]
      .filter((n) => lot === null || n === lot)
      .sort((a, b) => a - b);

    const lots = lotNumbers.map((lotNumber) => {
      const stats = statsByLot.get(lotNumber);
      const award = awardByLot.get(lotNumber) ?? null;
      const budget = num(stats.budget_price ?? award?.estimated_value);
      const winningPrice = num(award?.amount);
      const winningNet = num(award?.net_amount);

      const rows = ledger.filter((b) => b.lot_number === lotNumber);
      const visible = includeRejected ? rows : rows.filter((b) => b.status === 'accepted');

      return {
        lotNumber,
        name: stats.lot_name ?? award?.lot_name ?? null,
        cpvCode: stats.cpv_code ?? award?.cpv_code ?? null,
        budgetPrice: budget,
        currency: award?.currency ?? rows[0]?.currency ?? tender.currency,

        // Participation — rejected bids counted, because being rejected is
        // still having shown up and still being someone a supplier competed
        // against on price.
        bidderCount: stats.bidder_count,
        acceptedCount: stats.accepted_count,
        rejectedCount: stats.rejected_count,
        competition: band(stats.bidder_count),

        winner: award
          ? {
              supplierId: award.supplier_id,
              name: award.supplier_name,
              region: award.supplier_region ?? null,
              price: winningPrice,
              netPrice: winningNet,
              discountPct: discountPct(winningPrice, budget),
              awardedAt: award.awarded_at,
            }
          : null,

        // A lot whose every bid was rejected has a ledger and no award. Saying
        // so is the honest answer; inferring a winner from rank would name a
        // company the buyer explicitly threw out.
        outcome: award ? 'awarded' : 'no_accepted_bid',

        // Money spread over ACCEPTED bids only. Rejected submissions carry
        // real but absurd figures — one was 6,666,600,000,000 AMD against a
        // 75,000 budget — and including them destroys any price statistic.
        // Without VAT, like the gap from the winner.
        priceRange:
          stats.accepted_count > 0
            ? { low: num(stats.lowest_accepted), high: num(stats.highest_accepted) }
            : null,

        bids: visible.map((b) => {
          const opening = openingOffer(b.initial_offer_price, budget);
          return {
          supplierId: b.supplier_id,
          name: b.supplier_name,
          region: b.supplier_region ?? null,
          rank: b.rank,
          // Null when it contradicts the budget the same row publishes; the
          // flag says that happened rather than leaving it looking absent.
          initialOffer: opening.value,
          initialOfferUnreliable: opening.unreliable,
          initialOfferNet: opening.value === null ? null : num(b.initial_offer_net),
          finalOffer: num(b.final_offer_price),
          finalOfferNet: num(b.final_offer_net),
          vatPct: b.vat_pct === null ? null : Number(b.vat_pct),
          // Verbatim from the source's own participant-status column, never
          // inferred. A supplier reading this is entitled to know that a low
          // headline price was not actually in contention.
          status: b.status,
          isWinner: b.is_winner === true,
          discountPct: discountPct(b.final_offer_price, budget),
          gapFromWinnerPct: gapPct(b.final_offer_net, winningNet),
          applicationUrl: b.application_url,
          };
        }),
      };
    });

    return {
      status: 'ok',
      tenderId: tender.id,
      settled: true,
      currency: tender.currency,
      summary: CompetitorPriceService.summarize(lots, ledger),
      expectedCompetition: expected,
      lots,
    };
  }

  /** Tender-level roll-up. Same accepted-only rule for money, all-bids for counts. */
  static summarize(lots, ledger) {
    const awarded = lots.filter((l) => l.winner);
    const withBudget = awarded.filter((l) => l.budgetPrice > 0);

    const totalAwarded = awarded.reduce((sum, l) => sum + (l.winner.price ?? 0), 0);
    const totalBudget = withBudget.reduce((sum, l) => sum + l.budgetPrice, 0);
    const totalBidders = lots.reduce((sum, l) => sum + l.bidderCount, 0);

    return {
      lotCount: lots.length,
      lotsAwarded: awarded.length,
      lotsWithNoAcceptedBid: lots.length - awarded.length,
      totalAwarded: awarded.length ? Math.round(totalAwarded * 100) / 100 : null,
      totalBudget: withBudget.length ? Math.round(totalBudget * 100) / 100 : null,
      // Computed from the totals, not as a mean of per-lot percentages: a mean
      // of ratios weights a 50,000 AMD lot the same as a 50,000,000 one.
      totalDiscountPct: totalBudget > 0 ? discountPct(totalAwarded, totalBudget) : null,
      // Distinct companies across the whole tender — smaller than the sum of
      // per-lot counts, because the same company usually bids on every lot.
      distinctBidders: new Set(ledger.map((b) => b.supplier_id).filter(Boolean)).size,
      avgBiddersPerLot: lots.length ? Math.round((totalBidders / lots.length) * 10) / 10 : null,
      soleBidderLots: lots.filter((l) => l.competition === 'sole').length,
    };
  }
}
