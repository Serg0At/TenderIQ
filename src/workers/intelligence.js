import config from '../configs/variables.config.js';
import benchmarks from '../repositories/benchmark.repo.js';
import profiles from '../repositories/profile.repo.js';
import BenchmarkService from '../services/benchmark.service.js';
import ProfileService from '../services/profile.service.js';
import { logger } from '../utils/logger.js';

const { INTELLIGENCE } = config;

/**
 * Keep materialised benchmarks current.
 *
 * Benchmarks are precomputed because the reference requires intelligence reads
 * under 2 seconds, and a percentile over the whole award corpus is not a
 * request-time operation. That makes staleness the cost, and this is what pays
 * it: a targeted refresh when one tender settles, and a full sweep on a
 * schedule to catch anything the targeted path missed.
 */

/** Refresh only the categories a freshly settled tender touched. */
export const recomputeForTender = async (tenderId) => {
  const categories = await benchmarks.categoriesForTender(tenderId);
  let updated = 0;

  for (const cpvCode of categories) {
    const result = await BenchmarkService.recompute({ cpvCode });
    if (result.status === 'ok') updated += 1;
  }

  return { tenderId, categories: categories.length, updated };
};

/**
 * Recompute every category that has awards.
 *
 * Cheap enough to run nightly: the work is a handful of aggregate queries per
 * category, all in the database. It also repairs anything the targeted path
 * missed — a benchmark that was `insufficient_data` yesterday may clear the
 * threshold today purely because the seed advanced.
 */
export const recomputeAll = async () => {
  const categories = await benchmarks.categoriesWithAwards();
  let ok = 0;
  let thin = 0;

  for (const cpvCode of categories) {
    const result = await BenchmarkService.recompute({ cpvCode });
    result.status === 'ok' ? (ok += 1) : (thin += 1);
  }

  // Then the buyer-specific rows. `buyer_exact_cpv` is the benchmark service's
  // strongest tier — the same agency buying the same thing is the same market —
  // but it was previously only ever computed live, for whichever tender someone
  // opened. Materialising it makes the best answer also the fast one.
  //
  // The pair list is pre-filtered in SQL to pairs that already hold enough
  // awards to clear the threshold: 44 of a possible 114,774 today. Without that
  // this loop would be the cross product of every category and every buyer.
  const pairs = await benchmarks.buyerCategoryPairs({
    minCount: INTELLIGENCE.MIN_COMPARABLES,
    sinceMonths: INTELLIGENCE.RECENCY_MONTHS,
  });

  let buyerOk = 0;
  for (const { cpvCode, buyerId } of pairs) {
    const result = await BenchmarkService.recompute({ cpvCode, buyerId });
    if (result.status === 'ok') buyerOk += 1;
  }

  logger.info(
    `[intelligence] recomputed ${categories.length} categories — ${ok} published, ${thin} still below threshold; ` +
      `${pairs.length} buyer/category pairs — ${buyerOk} published`
  );

  return {
    categories: categories.length,
    published: ok,
    insufficient: thin,
    buyerPairs: pairs.length,
    buyerPublished: buyerOk,
  };
};

/**
 * Rebuild every buyer and supplier profile.
 *
 * Materialised for the same reason benchmarks are — the reference budgets
 * intelligence reads at under 2 seconds — but the read path deliberately does
 * NOT depend on these rows: `ProfileService.forSupplier` assembles its answer
 * live from indexed single-party lookups, so a profile is correct the moment a
 * tender settles rather than the morning after. The stored rows exist for the
 * things that need the whole population at once: ranking suppliers, exports,
 * and the AI layer's evidence packet.
 *
 * Set-based, not a loop. Rebuilding one party at a time measured at roughly 25
 * minutes against a remote Postgres — 1,220 suppliers x 4 round trips — and
 * that number grows linearly with a corpus currently 2.5% seeded. Every
 * aggregate involved is a `GROUP BY` on the party id, so the whole population
 * comes back in three queries and goes out in chunked upserts.
 *
 * The win-rate threshold is applied HERE as well as in the API. A stored rate
 * of 1.0 drawn from a single bid would be indistinguishable from a real one to
 * anything reading `supplier_profiles` directly — an export, or the AI layer's
 * evidence packet — which is exactly how a fabricated number escapes the one
 * place that knows it is thin.
 */
export const recomputeProfiles = async () => {
  const [supplierRows, buyerRows] = await Promise.all([
    profiles.computeAllSuppliers(),
    profiles.computeAllBuyers(),
  ]);

  let thinWinRate = 0;

  const suppliers = supplierRows.map((r) => {
    const enough = r.lotsBid >= INTELLIGENCE.MIN_COMPARABLES;
    if (!enough) thinWinRate += 1;
    return {
      supplier_id: r.supplierId,
      // Stored as a 0–1 fraction, matching the column's `float` type, and null
      // rather than a number when the sample cannot support a rate.
      win_rate: enough ? r.lotsWon / r.lotsBid : null,
      categories: r.categories,
      avg_discount_pct: r.avgDiscountPct,
    };
  });

  const buyers = buyerRows.map((r) => ({
    buyer_id: r.buyerId,
    total_spend: r.totalSpend,
    tender_count: r.tenderCount,
    favored_supplier_ids: r.favoredSupplierIds,
  }));

  const [supplierCount, buyerCount] = await Promise.all([
    profiles.bulkUpsert('supplier_profiles', 'supplier_id', suppliers),
    profiles.bulkUpsert('buyer_profiles', 'buyer_id', buyers),
  ]);

  logger.info(
    `[intelligence] profiles rebuilt — ${supplierCount} suppliers ` +
      `(${thinWinRate} below the ${INTELLIGENCE.MIN_COMPARABLES}-bid threshold, win rate withheld), ` +
      `${buyerCount} buyers`
  );
  return { suppliers: supplierCount, buyers: buyerCount, winRateWithheld: thinWinRate };
};

export const handleRecomputeBenchmarks = async (job) => {
  const { tenderId = null } = job.data ?? {};
  return tenderId ? recomputeForTender(tenderId) : recomputeAll();
};

/**
 * Both grains, mirroring the benchmark job: an empty payload rebuilds the whole
 * population, a payload naming one party refreshes just that one.
 *
 * The targeted path matters because a settling tender changes the win rate of
 * every company that bid on it, and waiting for the nightly sweep would leave a
 * competitor profile stale for up to a day at the moment it is most likely to
 * be looked at.
 */
export const handleRecomputeProfiles = async (job) => {
  const { supplierId = null, buyerId = null } = job?.data ?? {};
  if (supplierId) return ProfileService.recomputeSupplier(supplierId);
  if (buyerId) return ProfileService.recomputeBuyer(buyerId);
  return recomputeProfiles();
};

export default {
  recomputeForTender,
  recomputeAll,
  recomputeProfiles,
  handleRecomputeBenchmarks,
  handleRecomputeProfiles,
};
