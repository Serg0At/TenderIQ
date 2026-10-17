import tenders from '../../repositories/tender.repo.js';
import { purchaseKindOf, purchaseKindLabels } from '../../libs/purchaseKinds.js';
import { cpvPrefixesFor } from '../../libs/fields.js';
import { ApiError } from '../../utils/errors.js';

/** Comma-separated or repeated query params both arrive here as one list. */
const toList = (value) => {
  if (!value) return [];
  return (Array.isArray(value) ? value : String(value).split(','))
    .map((v) => String(v).trim())
    .filter(Boolean);
};

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
      limit: page.size ?? 20,
      cursor: page.cursor || null,
    });

    return { rows: rows.map(TenderService.present), cursor, hasMore };
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
