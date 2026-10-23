import config from '../configs/variables.config.js';
import benchmarks from '../repositories/benchmark.repo.js';

const { INTELLIGENCE } = config;

/**
 * Price benchmarks — "similar tenders won at X–Y".
 *
 * The rule that governs everything here: **below the comparables threshold,
 * report `insufficient_data` and never invent a number.** The reference calls
 * trust the moat, and a benchmark computed from two awards is a guess wearing
 * the costume of a statistic. A supplier who loses money once on a fabricated
 * number never believes the next one.
 */

/**
 * Comparable selection, most specific first.
 *
 * The spec defines comparables as "same/related CPV, similar subject/buyer,
 * recent", so this widens in stages rather than grouping bluntly by category:
 *
 *   1. this buyer, this exact category — the closest possible comparable, since
 *      the same agency buying the same thing is the same market
 *   2. this exact category, any buyer
 *   3. the category family (33141211 -> 3314... -> 33...), any buyer
 *
 * The first tier that clears the threshold wins, and the tier used is returned
 * as `basis` so the answer carries its own provenance — a median drawn from a
 * broad family is a weaker claim than one drawn from the exact code, and the
 * caller is told which it got.
 */
const TIERS = [
  { basis: 'buyer_exact_cpv', exact: true, useBuyer: true },
  { basis: 'exact_cpv', exact: true, useBuyer: false },
  { basis: 'cpv_family', exact: false, useBuyer: false },
];

/*
 * Single-source awards (ticket 31) are left out of every tier, the same way:
 * a price a buyer agreed with one supplier says nothing about what a market
 * bids, and most of them come from gnumner contract notices of procedures
 * never announced at all. Each tier counts only competitive awards against
 * the same threshold, so a category whose awards are mostly single-source is
 * `insufficient_data` rather than benchmarked on them. A caller who wants them
 * anyway asks (`includeSingleSource`): the answer is then computed live —
 * materialised rows never hold them — and says `includesSingleSource`.
 */

export default class BenchmarkService {
  /**
   * Compute (but do not store) the best available benchmark for a category.
   *
   * @returns {{status:'ok'|'insufficient_data', basis?:string, ...stats}}
   */
  static async compute({ cpvCode, buyerId = null, sinceMonths = INTELLIGENCE.RECENCY_MONTHS, includeSingleSource = false }) {
    if (!cpvCode) {
      return { status: 'insufficient_data', reason: 'tender has no CPV code', sampleSize: 0 };
    }

    let widest = null;

    for (const tier of TIERS) {
      if (tier.useBuyer && !buyerId) continue;

      const stats = await benchmarks.statsFor({
        cpvCode,
        exact: tier.exact,
        buyerId: tier.useBuyer ? buyerId : null,
        sinceMonths,
        includeSingleSource,
      });

      widest = { ...stats, basis: tier.basis };
      if (stats.sampleSize >= INTELLIGENCE.MIN_COMPARABLES) {
        return { status: 'ok', ...stats, basis: tier.basis, sinceMonths, ...(includeSingleSource ? { includesSingleSource: true } : {}) };
      }
    }

    // Every tier came up short. The widest attempt's count is returned so the
    // client can say "3 of 5 needed" rather than a bare refusal — and so the
    // gap is visible rather than looking like a bug.
    return {
      status: 'insufficient_data',
      reason: `fewer than ${INTELLIGENCE.MIN_COMPARABLES} comparable awards`,
      sampleSize: widest?.sampleSize ?? 0,
      required: INTELLIGENCE.MIN_COMPARABLES,
      basis: widest?.basis,
      ...(includeSingleSource ? { includesSingleSource: true } : {}),
    };
  }

  /**
   * Compute and materialise. Only an `ok` result is stored: persisting a thin
   * sample would make it look authoritative to anything reading the table
   * directly, and `price_benchmarks` has no column to mark a row untrustworthy.
   */
  static async recompute({ cpvCode, buyerId = null }) {
    const result = await BenchmarkService.compute({ cpvCode, buyerId });
    if (result.status !== 'ok') return result;

    await benchmarks.upsert({ cpvCode, buyerId, stats: result });
    return result;
  }

  /**
   * Read path for the API: the stored row, or an honest refusal. Asked to
   * include single-source awards, it computes live: the stored rows hold none.
   */
  static async forCategory({ cpvCode, buyerId = null, includeSingleSource = false }) {
    if (!cpvCode) {
      return { status: 'insufficient_data', reason: 'tender has no CPV code', sampleSize: 0 };
    }
    if (includeSingleSource) return BenchmarkService.compute({ cpvCode, buyerId, includeSingleSource });

    const stored = await benchmarks.find({ cpvCode, buyerId });
    if (stored && stored.sample_size >= INTELLIGENCE.MIN_COMPARABLES) {
      return {
        status: 'ok',
        cpvCode: stored.cpv_code,
        sampleSize: stored.sample_size,
        // How many separate procurements those awards came from. A sample of
        // 30 lots drawn from one tender is one observation, not 30.
        distinctTenders: stored.distinct_tenders ?? null,
        minPrice: stored.min_price === null ? null : Number(stored.min_price),
        medianPrice: stored.median_price === null ? null : Number(stored.median_price),
        maxPrice: stored.max_price === null ? null : Number(stored.max_price),
        // Number() strips the numeric type's trailing zeros: '6.88' not '6.8800'.
        avgDiscountPct: stored.avg_discount_pct === null ? null : Number(stored.avg_discount_pct),
        computedAt: stored.computed_at,
        basis: 'materialized',
      };
    }

    // Nothing materialised yet — compute live rather than answering "no data"
    // for a category the recompute job simply has not reached.
    return BenchmarkService.compute({ cpvCode, buyerId });
  }
}
