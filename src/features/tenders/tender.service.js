import tenders from '../../repositories/tender.repo.js';
import { SUPERSEDED } from '../../repositories/tenderSource.repo.js';
import relevance from '../../repositories/relevance.repo.js';
import { rankTenders, basisOf, compareRanked, isPursued, hasAnyCode } from '../../services/relevance.service.js';
import { purchaseKindOf, purchaseKindLabels } from '../../libs/purchaseKinds.js';
import { cpvPrefixesFor } from '../../libs/fields.js';
import config from '../../configs/variables.config.js';
import { signRelevance } from '../../libs/relevanceReceipt.js';
import { ApiError } from '../../utils/errors.js';
import TenderDocumentService from '../../services/tenderDocument.service.js';

/** Comma-separated or repeated query params both arrive here as one list. */
const toList = (value) => {
  if (!value) return [];
  return (Array.isArray(value) ? value : String(value).split(','))
    .map((v) => String(v).trim())
    .filter(Boolean);
};

/** The Discovery filters, from validated query shape to repository shape. Shared by both lists. */
const filtersOf = (f = {}) => ({
  cpvCodes: toList(f.cpv),
  keyword: f.keyword || null,
  buyerId: f.buyerId ?? null,
  region: f.region ?? null,
  procedureType: f.procedure ?? null,
  submissionChannels: toList(f.submissionChannel),
  status: f.status ?? null,
  minValue: f.minValue ?? null,
  maxValue: f.maxValue ?? null,
  deadlineAfter: f.deadlineAfter ?? null,
  deadlineBefore: f.deadlineBefore ?? null,
  purchaseKindLabels: purchaseKindLabels(toList(f.purchaseKind)),
  cpvPrefixes: cpvPrefixesFor(toList(f.field)),
  // The inferred-CPV gate (ADR 0006): which kinds' inferred lot codes the CPV
  // and field filters, and relevance's lot codes, read. Never a request value.
  inferredKinds: config.CPV_INFERENCE.READ_KINDS,
});

/**
 * How many tenders one relevance request will rank. Biddable tenders number in
 * the low hundreds; this only bites when an explicit status filter reaches into
 * the archive, and then the honest answer is "narrow it", not a ranking of an
 * arbitrary slice.
 */
const MAX_RANKABLE = 2000;

/** Most recent tenders the text fallback compares against; enough to characterise a supplier. */
const TEXT_PROFILE_SIZE = 300;

/**
 * The text fallback's inputs, loaded only when some candidate has no CPV code
 * anywhere — 1 in 150 today — and only then: the profile is the tenders the
 * organization bid on (public ledger) or pursued, most recent first.
 */
const withTextFallback = async (candidates, signals) => {
  const uncoded = candidates.filter((c) => !hasAnyCode(c));
  if (!uncoded.length) return { candidates, signals };

  const recent = [
    ...signals.ledger.items.map((i) => ({ id: i.tenderId, at: i.at })),
    ...signals.pipeline.filter(isPursued).map((p) => ({ id: p.tenderId, at: p.at })),
  ].sort((a, b) => new Date(b.at ?? 0) - new Date(a.at ?? 0));
  const profileIds = [...new Set(recent.map((r) => r.id))].slice(0, TEXT_PROFILE_SIZE);
  if (!profileIds.length) return { candidates, signals };

  const texts = await relevance.textFor([...uncoded.map((c) => c.id), ...profileIds]);
  return {
    candidates: candidates.map((c) => (texts.has(c.id) && uncoded.includes(c) ? { ...c, text: texts.get(c.id) } : c)),
    signals: { ...signals, textProfile: profileIds.map((id) => texts.get(id)).filter(Boolean) },
  };
};

/** The filters a client can use by hand when there is nothing to rank on yet. */
const FALLBACK_FILTERS = ['field', 'purchaseKind'];

/**
 * Relevance cursor: the full sort key of the last row served — score, deadline,
 * id. The ranking is recomputed per request, so the cursor cannot be a position;
 * it is the key the next page starts strictly after.
 */
const encodeRankCursor = (row) =>
  Buffer.from(
    JSON.stringify([row.score, row.deadlineAt ? new Date(row.deadlineAt).toISOString() : null, row.id])
  ).toString('base64url');

const decodeRankCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const [score, deadlineAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof score !== 'number' || typeof id !== 'string') return null;
    if (deadlineAt !== null && Number.isNaN(Date.parse(deadlineAt))) return null;
    return { score, deadlineAt, id };
  } catch {
    return null;
  }
};

/** A tender row as `rankTenders` reads it. */
const candidateOf = (row) => ({
  id: row.id,
  title: row.title,
  referenceCode: row.reference_code,
  cpvCode: row.cpv_code,
  cpvCodes: row.cpv_codes ?? [],
  buyerId: row.buyer_id,
  estimatedValue: row.estimated_value === null ? null : Number(row.estimated_value),
  deadlineAt: row.deadline_at,
  publishedAt: row.published_at,
  lots: (row.lots ?? []).map((l) => ({ lotNumber: l.lot_number, codes: l.codes ?? [], keywordHits: l.keyword_hits ?? [] })),
  row,
});

export default class TenderService {
  /**
   * Tender data is public procurement information, so this is not tenant-scoped
   * — every organization sees the same corpus. Only the private layers on top
   * (tracked tenders, bids, vault) are scoped, which is why they live in other
   * repositories that take an organization.
   */
  static async search(query) {
    const f = query.filter ?? {};
    const page = query.page ?? {};

    const { rows, cursor, hasMore } = await tenders.search({
      ...filtersOf(f),
      limit: page.size ?? 20,
      cursor: page.cursor || null,
    });

    return { rows: rows.map(TenderService.present), cursor, hasMore };
  }

  /**
   * The relevant list: biddable tenders ordered by fit to one organization.
   *
   * The first organization-scoped read under /tenders, so the organization is
   * an explicit argument here rather than inherited from the public corpus
   * path's tenant-free assumption. Scored per request over the whole candidate
   * set — a few hundred tenders — and paged afterwards; nothing is stored, so a
   * claimed supplier identity or a new pursuit shows on the next request.
   *
   * With nothing to rank on, the answer is a successful empty page naming what
   * is missing, in the shape `/tracked-tenders/performance` uses for
   * `insufficient_data` — never an order invented from zeroes.
   *
   * `now` is a parameter so a caller can rank as of another moment; the route
   * passes the real clock.
   */
  static async relevant(organizationId, query = {}, { now = new Date() } = {}) {
    const page = query.page ?? {};
    const limit = page.size ?? 20;

    const signals = await relevance.signalsFor(organizationId, { inferredKinds: config.CPV_INFERENCE.READ_KINDS });
    const basis = basisOf(signals);
    if (!basis.sufficient) {
      return {
        rows: [],
        meta: {
          basis: 'insufficient_data',
          missing: basis.missing,
          fallbackFilters: FALLBACK_FILTERS,
          cursor: null,
          hasMore: false,
        },
      };
    }

    const { rows, overflow } = await tenders.findRankable({
      ...filtersOf(query.filter ?? {}),
      keywords: [...new Set(signals.savedSearches.flatMap((s) => s.keywords))],
      biddableAt: now,
      cap: MAX_RANKABLE,
    });
    if (overflow) {
      throw ApiError.validation([
        { field: 'filter', message: `More than ${MAX_RANKABLE} tenders match; narrow the filter to rank them.` },
      ]);
    }

    const prepared = await withTextFallback(rows.map(candidateOf), signals);
    const ranked = rankTenders(prepared.candidates, prepared.signals, {
      now,
      recencyMonths: config.RELEVANCE.FULL_WEIGHT_MONTHS,
    });

    const after = decodeRankCursor(page.cursor);
    const rest = after ? ranked.filter((r) => compareRanked(r, after) > 0) : ranked;
    const served = rest.slice(0, limit);
    const hasMore = rest.length > limit;

    // Signed as shown, so tracking from this list can record exactly this.
    const shownAt = new Date().toISOString();
    return {
      rows: served.map((r) => {
        const shown = { score: r.score, band: r.band, reasons: r.reasons, shownAt };
        return {
          ...TenderService.present(r.tender.row),
          relevance: { ...shown, tracking: r.tracking, signature: signRelevance(organizationId, r.id, shown) },
        };
      }),
      meta: {
        basis: 'ranked',
        missing: basis.missing,
        cursor: served.length ? encodeRankCursor(served[served.length - 1]) : null,
        hasMore,
      },
    };
  }

  static async detail(id) {
    const tender = await tenders.findDetail(id);
    if (!tender) throw ApiError.notFound('Tender');
    return TenderService.presentDetail(tender);
  }

  /**
   * One file from a tender's stored invitation archive. Public procurement
   * data, so gated like the detail page and nothing more — no plan, no tenant.
   */
  static async documentFile(tenderId, documentId, index) {
    return TenderDocumentService.openFile(tenderId, documentId, index);
  }

  /**
   * Source column names never reach the client: the wire shape is camelCase and
   * stable, so renaming a column stays an internal change.
   */
  static present(row) {
    return {
      id: row.id,
      sourceId: row.source_id,
      title: row.title,
      referenceCode: row.reference_code,
      cpvCode: row.cpv_code,
      cpvCodes: row.cpv_codes ?? [],
      procedureType: row.procedure_type,
      submissionChannel: row.submission_channel,
      purchaseKind: purchaseKindOf(row.goods_works_services),
      evaluationMethod: row.evaluation_method ?? null,
      // Where a paper bid is delivered; null for a tender bid online.
      submissionAddress: row.submission_address ?? null,
      status: row.status,
      sourceStatus: row.source_status,
      estimatedValue: row.estimated_value === null ? null : Number(row.estimated_value),
      currency: row.currency,
      publishedAt: row.published_at,
      deadlineAt: row.deadline_at,
      auctionAt: row.auction_at,
      buyer: { id: row.buyer_id, name: row.buyer_name, region: row.buyer_region ?? null },
    };
  }

  static presentDetail(row) {
    // Each stated code's Armenian name from the CPV classifier; null for a
    // code the classifier lacks (cpv-inference ticket 01).
    const names = row.cpv_names ?? new Map();
    const nameOf = (code) => (code ? names.get(code) ?? null : null);
    // Inferred lot codes (ADR 0006), beside the stated ones and never merged
    // into `cpvCodes`: a guess must stay distinguishable from what the source
    // states. Named from the lots, which carry the classifier name of the code
    // they show.
    const inferred = new Map();
    for (const l of row.lots ?? []) {
      if (l.inferred_cpv_code && !inferred.has(l.inferred_cpv_code)) inferred.set(l.inferred_cpv_code, l.cpv_name ?? null);
    }
    const inferredCodes = [...inferred.keys()].sort();
    return {
      ...TenderService.present(row),
      cpvName: nameOf(row.cpv_code),
      cpvNames: Object.fromEntries((row.cpv_codes ?? []).map((code) => [code, nameOf(code)])),
      inferredCpvCodes: inferredCodes,
      inferredCpvNames: Object.fromEntries(inferredCodes.map((code) => [code, inferred.get(code)])),
      buyer: { id: row.buyer_id, name: row.buyer_name, taxId: row.buyer_tax_id ?? null, region: row.buyer_region ?? null },
      // What is being bought, as the source states it beside the title. Only
      // a paper invitation states one today; null elsewhere.
      description: row.description ?? null,
      qnaDeadlineAt: row.qna_deadline_at,
      invitationUrl: row.invitation_url,
      version: row.version,
      lots: (row.lots ?? []).map((l) => ({
        lotNumber: l.lot_number,
        cpvCode: l.cpv_code,
        // Tendra's guess for a lot whose source states no code; null when the
        // lot states one or could not be classified.
        inferredCpvCode: l.inferred_cpv_code ?? null,
        // The name of whichever code the lot shows, stated or inferred.
        cpvName: l.cpv_name ?? null,
        name: l.name,
      })),
      documents: TenderDocumentService.present(row),
      // Where this tender was read from. The external id stays internal: the
      // URL is what a supplier can use, and the id is our join key. A
      // superseded run is left out: its page is the amended-away version, and
      // offering it as a source would send a supplier to the old deadline
      // (ticket 29).
      sources: (row.sources ?? [])
        .filter((s) => s.observed_status !== SUPERSEDED)
        .map((s) => ({ source: s.source, url: s.url, role: s.role })),
    };
  }
}
