import BenchmarkService from '../../services/benchmark.service.js';
import CompetitorPriceService from '../../services/competitorPrice.service.js';
import ProfileService from '../../services/profile.service.js';
import PriceRecommendationService from '../../services/priceRecommendation.service.js';
import tenders from '../../repositories/tender.repo.js';
import parties from '../../repositories/party.repo.js';
import { ok } from '../../utils/respond.js';
import { ApiError } from '../../utils/errors.js';

export default class IntelligenceController {
  /**
   * The benchmark panel for one tender — the "wow screen" the reference says to
   * put above the fold and measure trial-to-paid on.
   *
   * Resolves the tender's own category and buyer, so the client asks about a
   * tender rather than having to know how comparables are selected.
   */
  static async tenderBenchmark(req, res) {
    const tender = await tenders.findDetail(req.params.id);
    if (!tender) throw ApiError.notFound('Tender');

    // A multi-category tender is benchmarked on its headline code; per-lot
    // benchmarks are available through the category endpoint.
    const cpvCode = tender.cpv_code ?? tender.lots?.find((l) => l.cpv_code)?.cpv_code ?? null;

    const benchmark = await BenchmarkService.forCategory({
      cpvCode,
      buyerId: tender.buyer_id,
      includeSingleSource: req.query.filter?.includeSingleSource === true,
    });

    return ok(res, {
      tenderId: tender.id,
      cpvCode,
      estimatedValue: tender.estimated_value === null ? null : Number(tender.estimated_value),
      currency: tender.currency,
      benchmark,
    });
  }

  /** Benchmark for a category directly, optionally narrowed to one buyer. */
  static async categoryBenchmark(req, res) {
    const { cpv } = req.params;
    const buyerId = req.query.buyerId ?? null;
    const includeSingleSource = req.query.filter?.includeSingleSource === true;
    return ok(res, await BenchmarkService.forCategory({ cpvCode: cpv, buyerId, includeSingleSource }));
  }

  /**
   * Competitor winning prices for one tender — who won each lot, at what price,
   * against how many bidders.
   *
   * Unlike the benchmark panel this needs no CPV code: it is keyed entirely by
   * tender id, so it works on the whole corpus rather than the third of it that
   * has a category. That makes it the intelligence section's headline.
   */
  static async competitorPrices(req, res) {
    const tender = await tenders.findDetail(req.params.id);
    if (!tender) throw ApiError.notFound('Tender');

    const f = req.query.filter ?? {};
    const result = await CompetitorPriceService.forTender(tender, {
      lot: f.lot ?? null,
      includeRejected: f.includeRejected !== false,
      includeSingleSource: f.includeSingleSource === true,
    });

    return ok(res, {
      ...result,
      title: tender.title,
      referenceCode: tender.reference_code,
      buyer: { id: tender.buyer_id, name: tender.buyer_name, region: tender.buyer_region ?? null },
    });
  }

  /**
   * How many bidders a lot like this one draws — the estimate, not the record.
   *
   * The only piece of competitor intelligence that works on a tender still open
   * for bidding, which is the only kind a supplier can act on. Answerable from
   * the same ledger with a COUNT, so it costs almost nothing to serve.
   */
  static async expectedCompetition(req, res) {
    const f = req.query.filter ?? {};
    return ok(
      res,
      await CompetitorPriceService.expectedCompetition({
        cpvCode: f.cpv ?? null,
        buyerId: f.buyerId ?? null,
        ...(f.sinceMonths ? { sinceMonths: f.sinceMonths } : {}),
        includeSingleSource: f.includeSingleSource === true,
      })
    );
  }

  /**
   * A competitor's profile — how often they bid, how often they win, how they
   * price, and who they run into.
   *
   * The role check is `!== 'buyer'` rather than `=== 'supplier'`: a party that
   * both buys and supplies is stored as 'both', and demanding an exact role
   * would 404 a genuine competitor.
   */
  static async supplierProfile(req, res) {
    const party = await parties.findById(req.params.id);
    if (!party || party.role === 'buyer') throw ApiError.notFound('Supplier');
    return ok(res, await ProfileService.forSupplier(party));
  }

  /** A buying agency's profile — what it spends, and how contested its work is. */
  static async buyerProfile(req, res) {
    const party = await parties.findById(req.params.id);
    if (!party || party.role === 'supplier') throw ApiError.notFound('Buyer');
    return ok(res, await ProfileService.forBuyer(party));
  }

  /**
   * What to bid, and why.
   *
   * Answers 200 in every case a client can act on, including the refusals:
   * `insufficient_data` when there are too few comparables to support any
   * recommendation, and `evidence_only` when the numbers exist but the
   * explanation could not be produced. Neither is a server error, and turning
   * either into a 4xx/5xx would make an honest answer look like a fault.
   */
  static async priceRecommendation(req, res) {
    const tender = await tenders.findDetail(req.params.id);
    if (!tender) throw ApiError.notFound('Tender');

    const result = await PriceRecommendationService.forTender(tender);
    return ok(res, { tenderId: tender.id, ...result });
  }
}
