import tenders from '../../repositories/tender.repo.js';
import relevance from '../../repositories/relevance.repo.js';
import { rankTenders, basisOf, compareRanked } from '../../services/relevance.service.js';
import { purchaseKindOf, purchaseKindLabels } from '../../libs/purchaseKinds.js';
import { cpvPrefixesFor } from '../../libs/fields.js';
import config from '../../configs/variables.config.js';
import { ApiError } from '../../utils/errors.js';

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
  status: f.status ?? null,
  minValue: f.minValue ?? null,
  maxValue: f.maxValue ?? null,
  deadlineAfter: f.deadlineAfter ?? null,
  deadlineBefore: f.deadlineBefore ?? null,
  purchaseKindLabels: purchaseKindLabels(toList(f.purchaseKind)),
  cpvPrefixes: cpvPrefixesFor(toList(f.field)),
});

/**
 * How many tenders one relevance request will rank. Biddable tenders number in
 * the low hundreds; this only bites when an explicit status filter reaches into
 * the archive, and then the honest answer is "narrow it", not a ranking of an
 * arbitrary slice.
 */
const MAX_RANKABLE = 2000;

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

    const signals = await relevance.signalsFor(organizationId);
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

    const ranked = rankTenders(rows.map(candidateOf), signals, {
      now,
      recencyMonths: config.RELEVANCE.FULL_WEIGHT_MONTHS,
    });

    const after = decodeRankCursor(page.cursor);
    const rest = after ? ranked.filter((r) => compareRanked(r, after) > 0) : ranked;
    const served = rest.slice(0, limit);
    const hasMore = rest.length > limit;

    return {
      rows: served.map((r) => ({
        ...TenderService.present(r.tender.row),
        relevance: { score: r.score, band: r.band, reasons: r.reasons, tracking: r.tracking },
      })),
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
      procedureType: row.procedure_type,
      purchaseKind: purchaseKindOf(row.goods_works_services),
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
    return {
      ...TenderService.present(row),
      buyer: { id: row.buyer_id, name: row.buyer_name, taxId: row.buyer_tax_id ?? null, region: row.buyer_region ?? null },
      qnaDeadlineAt: row.qna_deadline_at,
      invitationUrl: row.invitation_url,
      version: row.version,
      lots: (row.lots ?? []).map((l) => ({ lotNumber: l.lot_number, cpvCode: l.cpv_code, name: l.name })),
      documents: (row.documents ?? []).map((d) => ({ kind: d.kind, url: d.url, parsed: d.parsed })),
    };
  }
}
