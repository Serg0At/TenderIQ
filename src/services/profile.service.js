import config from '../configs/variables.config.js';
import profiles from '../repositories/profile.repo.js';

const { INTELLIGENCE } = config;

/**
 * Buyer and supplier profiles.
 *
 * A supplier profile is a **competitor** profile — the thing a customer buys
 * this product for. A buyer profile is the agency they are selling to.
 *
 * The honest-intelligence rule applies to every RATE on this page and to no
 * COUNT. "This company has bid 3 times and won 2" is a fact and is always
 * reported. "This company wins 67% of the time" is a statistic, it is drawn
 * from three observations, and it is the kind of number a supplier would price
 * against and lose money on. So counts are unconditional and rates are gated
 * behind the same `MIN_COMPARABLES` threshold benchmarks use — below it the
 * rate is null and carries its own explanation.
 *
 * The whole page is derived from published public record. Nothing tenant-
 * private is read, and every figure is reproducible from `tenders`, `awards`
 * and `public_tender_bids`.
 *
 * Single source (ticket 31; profile.repo.js): a figure that measures
 * competition — a win rate, a discount, bidder counts, rivals — is over
 * competitive procurement only unless the caller asks
 * (`includeSingleSource`, and the profile then says `includesSingleSource`);
 * a total — tenders, spend, contracts, revenue — counts everything and
 * carries its `split` into competitive and single source.
 */

/** A total and its two halves. `all` and `singleSource` come from one query, so `competitive` is their difference. */
const split = (all, singleSource, keys) => {
  const half = (pick) => Object.fromEntries(keys.map((k) => [k, pick(k)]));
  return {
    competitive: half((k) => (all[k] === null ? null : all[k] - (singleSource[k] ?? 0))),
    singleSource: half((k) => (all[k] === null ? null : (singleSource[k] ?? 0))),
  };
};

const num = (value) => (value === null || value === undefined ? null : Number(value));
const int = (value) => Number(value ?? 0);

/**
 * A ratio as a percentage, or null when the denominator is too small to carry
 * one. `sample` and `required` travel with the null so a client can say
 * "3 of 5 bids needed" rather than showing a blank.
 */
const rate = (numerator, denominator, { min = INTELLIGENCE.MIN_COMPARABLES } = {}) => {
  const d = Number(denominator);
  if (!Number.isFinite(d) || d <= 0) return { value: null, status: 'no_data', sample: 0 };
  if (d < min) {
    return { value: null, status: 'insufficient_data', sample: d, required: min };
  }
  return {
    value: Math.round((Number(numerator) / d) * 1000) / 10,
    status: 'ok',
    sample: d,
  };
};

export default class ProfileService {
  /**
   * A competitor's profile.
   *
   * `party` is the row from `parties`, resolved by the controller so existence
   * (and the 404) is decided in one place.
   */
  static async forSupplier(party, { sinceMonths = null, includeSingleSource = false } = {}) {
    const { activity, wins, contracts, categories, rivals } = await profiles.computeSupplier(party.id, {
      sinceMonths,
      includeSingleSource,
    });

    const lotsBid = int(activity?.lots_bid);
    const lotsWon = int(wins?.lots_won);
    const contractTotals = { lots: int(contracts?.lots), totalValue: num(contracts?.total_value) };

    return {
      supplier: {
        id: party.id,
        name: party.name,
        taxId: party.tax_id ?? null,
        region: party.region ?? null,
      },

      // Competition: bids on and wins of competitive procurement.
      activity: {
        lotsBid,
        lotsWon,
        lotsLost: lotsBid - lotsWon,
        tendersBid: int(activity?.tenders_bid),
        tendersWon: int(wins?.tenders_won),
        // Rejected bids are IN the denominator: being disqualified is still
        // having bid and still having lost. Reported separately so a reader
        // can see how much of the loss column is disqualification rather than
        // being outpriced — a materially different competitor.
        lotsRejected: int(activity?.lots_rejected),
        firstSeen: activity?.first_seen ?? null,
        lastSeen: activity?.last_seen ?? null,
      },

      // The headline figure, and the one that needs no CPV code — which is why
      // this endpoint works across the whole corpus while categories below are
      // thin.
      winRate: rate(lotsWon, lotsBid),

      pricing: {
        // How this company prices in general, over its accepted bids.
        avgDiscountPct: num(activity?.avg_discount_pct),
        // How deep it goes on the ones it actually takes. The gap between the
        // two is the useful signal: a competitor whose winning discount is far
        // below its typical one is winning on something other than price.
        avgWinningDiscountPct: num(wins?.avg_winning_discount_pct),
        // Won lots with a budget left out of that figure because their
        // contract is not the winning offer (a PPCM framework or partial
        // contract): no gross is guessed for them, and they are not hidden.
        winningDiscountExcludedLots: int(wins?.winning_discount_excluded),
      },

      // A total: every contract this company holds, single source included.
      contracts: {
        ...contractTotals,
        tenders: int(contracts?.tenders),
        largest: num(contracts?.largest),
        currency: 'AMD',
        split: split(
          contractTotals,
          { lots: int(contracts?.lots_single_source), totalValue: num(contracts?.value_single_source) ?? 0 },
          ['lots', 'totalValue']
        ),
      },

      /**
       * Categories require a CPV code, which exists on roughly a third of the
       * corpus, so this list understates what a competitor covers. Saying so
       * beats a silently short list that reads as "they don't do that".
       */
      categories: {
        status: categories.length ? 'ok' : 'no_data',
        coverageNote:
          'Derived from tenders whose CPV code is known. CPV is published only inside the invitation archive, so a supplier active in a category may not appear under it.',
        items: categories.map((c) => ({ cpvCode: c.cpv_code, lotsBid: int(c.lots_bid) })),
      },

      /**
       * Who this company keeps running into. Counted from shared lots, with
       * the head-to-head record attached as evidence.
       */
      frequentRivals: rivals,
      ...(includeSingleSource ? { includesSingleSource: true } : {}),
    };
  }

  /** A buying agency's profile. */
  static async forBuyer(party, { sinceMonths = null, includeSingleSource = false } = {}) {
    const { volume, spend, competition, suppliers } = await profiles.computeBuyer(party.id, {
      sinceMonths,
      includeSingleSource,
    });

    const lotsAwarded = int(spend?.lots_awarded);
    const totalSpend = num(spend?.total_spend);
    const sampleLots = int(competition?.sample_lots);
    const tenderCount = int(volume?.tender_count);

    return {
      buyer: {
        id: party.id,
        name: party.name,
        taxId: party.tax_id ?? null,
        region: party.region ?? null,
      },

      // Totals: every tender and award, single source included, with the split.
      volume: {
        tenderCount,
        tendersAwarded: int(spend?.tenders_awarded),
        lotsAwarded,
        firstSeen: volume?.first_seen ?? null,
        lastSeen: volume?.last_seen ?? null,
        split: split(
          { tenderCount, lotsAwarded },
          { tenderCount: int(volume?.tender_count_single_source), lotsAwarded: int(spend?.lots_awarded_single_source) },
          ['tenderCount', 'lotsAwarded']
        ),
      },

      spend: {
        totalSpend,
        totalBudget: num(spend?.total_budget),
        totalEstimated: num(volume?.total_estimated),
        // Competition, so competitive awards only: how far below its own
        // budget this buyer typically settles — the number a supplier uses to
        // judge how aggressively to price — and how many companies win it.
        avgDiscountPct: num(spend?.avg_discount_pct),
        // Budgeted lots left out of the discount because their contract is not
        // the winning offer — counted in `totalSpend`, never guessed a gross.
        discountExcludedLots: int(spend?.discount_excluded),
        distinctWinners: int(spend?.distinct_winners),
        currency: 'AMD',
        split: split({ totalSpend }, { totalSpend: num(spend?.spend_single_source) ?? 0 }, ['totalSpend']),
      },

      /**
       * How contested this buyer's work is. `soleBidderRate` is the one a
       * supplier should read first: a buyer whose lots routinely draw one
       * bidder is a buyer whose lots are winnable.
       */
      competition: {
        sampleLots,
        avgBidders: num(competition?.avg_bidders),
        medianBidders: num(competition?.median_bidders),
        soleBidderLots: int(competition?.sole_bidder_lots),
        soleBidderRate: rate(int(competition?.sole_bidder_lots), sampleLots),
      },

      /**
       * The suppliers that have won this buyer's work most often, with the
       * counts they were ranked on.
       *
       * Named `topSuppliers`, not "favored" — the stored column is called
       * `favored_supplier_ids` and that word is a conclusion this data cannot
       * support. Repeat wins have many ordinary explanations: the firm may be
       * the only one in the region that does the work, or simply the cheapest.
       * Non-competitive concerns are reportable only as signals with evidence,
       * never as accusations, so what ships is the evidence — award count,
       * value, share — and the reader draws their own conclusion.
       */
      topSuppliers: suppliers.map((s) => ({
        ...s,
        shareOfAwardsPct:
          lotsAwarded > 0 ? Math.round((s.awardCount / lotsAwarded) * 1000) / 10 : null,
        shareOfSpendPct:
          totalSpend > 0 ? Math.round(((s.totalValue ?? 0) / totalSpend) * 1000) / 10 : null,
      })),
      ...(includeSingleSource ? { includesSingleSource: true } : {}),
    };
  }

  // ------------------------------------------------------- materialise / read

  /**
   * Compute and store. Only the four columns the schema has are persisted; the
   * richer read above is assembled live from indexed single-party lookups,
   * which is well inside the 2s intelligence budget.
   *
   * A win rate that is below the threshold is stored as null rather than as a
   * number, so nothing reading `supplier_profiles` directly — a future export,
   * an AI prompt — can pick up a rate the API itself refuses to state.
   */
  static async recomputeSupplier(supplierId) {
    const { activity, wins, categories } = await profiles.computeSupplier(supplierId);
    const lotsBid = int(activity?.lots_bid);
    const winRate = rate(int(wins?.lots_won), lotsBid);

    await profiles.upsertSupplier({
      supplierId,
      winRate: winRate.value === null ? null : winRate.value / 100,
      categories: categories.map((c) => c.cpv_code),
      avgDiscountPct: num(activity?.avg_discount_pct),
    });

    return { supplierId, lotsBid, winRate: winRate.value };
  }

  static async recomputeBuyer(buyerId) {
    const { volume, spend, suppliers } = await profiles.computeBuyer(buyerId);

    await profiles.upsertBuyer({
      buyerId,
      totalSpend: num(spend?.total_spend),
      tenderCount: int(volume?.tender_count),
      favoredSupplierIds: suppliers.map((s) => s.supplierId),
    });

    return { buyerId, tenderCount: int(volume?.tender_count) };
  }
}
