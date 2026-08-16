import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';
import { stableHash } from '../utils/hash.js';
import parties from './party.repo.js';

const TABLE = 'tenders';

/**
 * Statuses from which a tender never moves again. Everything else is still
 * live enough to be worth re-checking.
 */
const TERMINAL_STATUSES = ['awarded', 'cancelled'];

/**
 * Money to a canonical form before hashing or diffing.
 *
 * node-postgres returns `decimal(18,2)` as a STRING, and no type parser is
 * registered, so a stored 165000 comes back as "165000.00" while the freshly
 * parsed candidate is the number 165000. Comparing them as strings made
 * `unchanged` permanently false: every re-normalize bumped `version`, emitted
 * TenderAmended, and listed estimated_value in changedFields — re-notifying
 * every subscriber on a tender that had not moved. Exactly the storm the
 * URL-exclusion rule in workers/scraper.js exists to prevent.
 */
const money = (value) => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : null;
};

/**
 * Fields whose movement constitutes an amendment. Anything a supplier would
 * act on belongs here; bookkeeping (fetched_at, storage keys) does not.
 */
const fieldHash = (tender) =>
  stableHash({
    title: tender.title,
    buyerId: tender.buyerId,
    referenceCode: tender.referenceCode,
    cpvCode: tender.cpvCode,
    procedureType: tender.procedureType,
    goodsWorksServices: tender.goodsWorksServices,
    status: tender.status,
    // Included so a move between two site states that share one enum value
    // (e.g. Նախաաճուրդային -> Աճուրդ, both `closed`) still registers as an
    // amendment rather than passing silently.
    sourceStatus: tender.sourceStatus,
    estimatedValue: money(tender.estimatedValue),
    currency: tender.currency,
    publishedAt: tender.publishedAt,
    deadlineAt: tender.deadlineAt,
    qnaDeadlineAt: tender.qnaDeadlineAt,
    auctionAt: tender.auctionAt,
  });

const toRow = (tender, buyerId) => ({
  title: tender.title,
  description: tender.description ?? null,
  buyer_id: buyerId,
  reference_code: tender.referenceCode ?? null,
  cpv_code: tender.cpvCode ?? null,
  procedure_type: tender.procedureType,
  goods_works_services: tender.goodsWorksServices ?? null,
  status: tender.status,
  source_status: tender.sourceStatus ?? null,
  estimated_value: tender.estimatedValue ?? null,
  currency: tender.currency,
  published_at: tender.publishedAt ?? null,
  deadline_at: tender.deadlineAt ?? null,
  qna_deadline_at: tender.qnaDeadlineAt ?? null,
  auction_at: tender.auctionAt ?? null,
  invitation_url: tender.invitationUrl ?? null,
});

/** Columns whose stored form is a decimal string; compared numerically. */
const MONEY_COLUMNS = new Set(['estimated_value']);

const changedKeys = (before, after) =>
  Object.keys(after).filter((key) => {
    const norm = (v) => {
      if (v instanceof Date) return v.toISOString();
      // Same decimal-as-string trap as fieldHash: without this, changedFields
      // reports estimated_value on every amendment even when it is identical.
      if (MONEY_COLUMNS.has(key)) return money(v) ?? '';
      return v ?? '';
    };
    return String(norm(before[key])) !== String(norm(after[key]));
  });

/**
 * Replace a finished tender's public bid ledger and its per-lot awards.
 *
 * Delete-then-insert rather than a row-wise merge: the detail page publishes
 * the ledger in full every time, so it is authoritative, and a lot that
 * disappears from it must disappear here too — but only when a ledger was
 * actually parsed. See the guard below.
 */
const replaceLedger = async (trx, { source, tenderId, lots, currency, awardedAt }) => {
  // Nothing parsed -> touch nothing. The delete used to run before this guard,
  // which made an empty parse destructive: ARMEPS adding one column to
  // Գնառաջարկներ makes parseBidLedger reject every row, and a finished tender's
  // entire ledger — its whole contribution to the benchmark corpus — would be
  // deleted with no error and no alarm, since labelsSeen stays > 0 so the
  // layout check still passes. An active tender legitimately has no ledger, so
  // "empty" can never be treated as authoritative here.
  if (!lots?.length) return { awards: 0, bids: 0 };

  const fetchedAt = new Date();
  const bidRows = [];
  const awardRows = [];
  const awardedLots = new Set();

  for (const lot of lots) {
    for (const bid of lot.bids) {
      const supplierId = await parties.upsertSupplier(
        { source, sourceId: bid.supplierSourceId, name: bid.supplierName },
        trx
      );

      // A bidder with no resolvable supplier id would collide with every other
      // such bidder on the (tender, lot, supplier) key, so it is counted out
      // rather than written under a null supplier.
      if (!supplierId) continue;

      bidRows.push({
        id: createId(),
        tender_id: tenderId,
        lot_number: lot.lotNumber,
        rank: bid.rank,
        supplier_id: supplierId,
        budget_price: lot.estimatedValue,
        initial_offer_price: bid.initialPrice,
        final_offer_price: bid.finalPrice,
        vat_pct: bid.finalVatPercent,
        // The source leaves the cell blank for a bid that stood; only a
        // rejection is spelled out.
        status: bid.participantStatus ? 'rejected' : 'accepted',
        application_url: bid.applicationUrl,
        currency,
        source,
        fetched_at: fetchedAt,
      });

      // One award per lot. A tie (or a re-run lot) can show two rank-1 bidders,
      // which would violate the awards unique key, abort the whole transaction
      // and leave the tender permanently un-normalized. The losing duplicate is
      // still preserved in full on public_tender_bids.
      if (bid.rank === 1 && !awardedLots.has(lot.lotNumber)) {
        awardedLots.add(lot.lotNumber);
        awardRows.push({
          id: createId(),
          tender_id: tenderId,
          lot_number: lot.lotNumber,
          supplier_id: supplierId,
          amount: bid.finalPrice,
          estimated_value: lot.estimatedValue,
          currency,
          awarded_at: awardedAt ?? null,
          status: 'awarded',
          source,
        });
      }
    }
  }

  // Delete immediately before the insert, and only once there is something to
  // insert. Scoped to this source: the ledger published by one source is
  // authoritative only for its own rows, so an unscoped delete would wipe a
  // second source's awards on every re-normalize. Both statements run in the
  // caller's transaction, so readers never observe the empty window.
  await trx('public_tender_bids').where({ tender_id: tenderId, source }).del();
  await trx('awards').where({ tender_id: tenderId, source }).del();

  if (bidRows.length) await trx('public_tender_bids').insert(bidRows);
  if (awardRows.length) await trx('awards').insert(awardRows);
  return { awards: awardRows.length, bids: bidRows.length };
};

export default class TenderRepository {
  static async findBySourceId(sourceId, trx = db) {
    return trx(TABLE).where({ source_id: sourceId }).first();
  }

  /**
   * Apply what the invitation archive revealed: the buyer's tax ID, the CPV
   * code, and a `tender_documents` row for the archive itself.
   *
   * These three fields exist nowhere in the HTML — only inside hraver.docx —
   * so this is the only path that can ever populate them. One transaction, so
   * a tender never shows a CPV whose source document was not recorded.
   */
  static async applyInvitationFacts({ sourceId, url, storageKey, taxId, cpvCode }) {
    return db.transaction(async (trx) => {
      const tender = await trx(TABLE).where({ source_id: sourceId }).first();
      if (!tender) return { skipped: 'unknown_tender' };

      // Only fills a blank: the detail page is authoritative for everything it
      // publishes, and re-running this must not churn `version`.
      if (cpvCode && !tender.cpv_code) {
        await trx(TABLE).where({ id: tender.id }).update({ cpv_code: cpvCode });
      }

      const taxIdSet = taxId ? await parties.setTaxId(tender.buyer_id, taxId, trx) : false;

      // Unique on (tender_id, storage_key), so a concurrent job losing this
      // race is a no-op rather than a duplicate row or a thrown 23505.
      const inserted = await trx('tender_documents')
        .insert({
          id: createId(),
          tender_id: tender.id,
          url,
          storage_key: storageKey,
          kind: 'invitation',
          parsed: true,
        })
        .onConflict(['tender_id', 'storage_key'])
        .ignore();

      return {
        tenderId: tender.id,
        cpvSet: Boolean(cpvCode && !tender.cpv_code),
        taxIdSet,
        documentRecorded: (inserted?.rowCount ?? 0) > 0,
      };
    });
  }

  /**
   * Tenders whose auction has happened but which have not reached a terminal
   * status — the ones whose bid ledger has probably appeared since we last
   * looked.
   *
   * This exists because the listing sweep cannot find them. The board is
   * ordered by tid descending and the sweep stops at its tid watermark, so it
   * only ever sees newly *published* tenders. A tender published a month ago
   * sits deep in the archive and does not move up when it finishes, so its
   * transition to Ավարտված — and the entire per-lot ledger that appears with
   * it — is invisible to pagination. Award coverage has to be driven from what
   * is already in the database instead.
   *
   * `auction_at` is preferred over `deadline_at`: results are published after
   * the auction, which is a day or so after bidding closes.
   *
   * The lower bound stops this from re-checking a tender forever. A tender
   * that never leaves `closed` is a source-side dead end, not something to
   * re-fetch hourly until the end of time.
   */
  static async findNeedingRefresh({ source, windowDays = 30, limit = 200 }, trx = db) {
    const now = new Date();
    const floor = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

    return trx(TABLE)
      .whereNotIn('status', TERMINAL_STATUSES)
      .andWhere('source_id', 'like', `${source}:%`)
      .andWhereRaw('COALESCE(auction_at, deadline_at) < ?', [now])
      .andWhereRaw('COALESCE(auction_at, deadline_at) > ?', [floor])
      // Oldest first: the ones most likely to have settled, and it makes the
      // batch cap drain a backlog in order instead of starving the tail.
      .orderByRaw('COALESCE(auction_at, deadline_at) ASC')
      .limit(limit)
      .select('id', 'source_id', 'status', 'auction_at', 'deadline_at');
  }

  /**
   * The pipeline's only write path into the domain tables.
   *
   * Buyer, tender and ledger land in one transaction: a tender must never be
   * visible without the buyer it references, and a half-written ledger would
   * skew every benchmark computed off it.
   *
   * NOTE on versioning: `tenders.source_id` is UNIQUE, so exactly one row can
   * exist per tender and an amendment can only update in place while advancing
   * `version`. Retaining superseded rows (which `is_latest` implies) needs the
   * constraint changed to UNIQUE(source_id, version) first. Deliberately left
   * as-is — that is a schema decision, not a normalizer one.
   */
  static async saveNormalized({ source, sourceId, buyerName, tender, lots }) {
    return db.transaction(async (trx) => {
      const buyerId = await parties.upsertBuyer({ source, name: buyerName }, trx);
      if (!buyerId) {
        // buyer_id is NOT NULL and there is no honest placeholder for it.
        // Skipping keeps the tender out until the page yields a real buyer.
        return { event: null, skipped: 'no_buyer' };
      }

      const candidate = { ...tender, buyerId };
      const row = toRow(candidate, buyerId);
      const existing = await trx(TABLE).where({ source_id: sourceId }).forUpdate().first();

      if (!existing) {
        const id = createId();
        await trx(TABLE).insert({ ...row, id, source_id: sourceId, version: 1, is_latest: true });
        const ledger = await replaceLedger(trx, {
          source,
          tenderId: id,
          lots,
          currency: tender.currency,
          awardedAt: tender.auctionAt,
        });
        return { event: 'TenderIngested', tenderId: id, version: 1, ...ledger };
      }

      const unchanged =
        fieldHash(candidate) ===
        fieldHash({
          title: existing.title,
          buyerId: existing.buyer_id,
          referenceCode: existing.reference_code,
          cpvCode: existing.cpv_code,
          procedureType: existing.procedure_type,
          goodsWorksServices: existing.goods_works_services,
          status: existing.status,
          sourceStatus: existing.source_status,
          estimatedValue: existing.estimated_value === null ? null : String(existing.estimated_value),
          currency: existing.currency,
          publishedAt: existing.published_at,
          deadlineAt: existing.deadline_at,
          qnaDeadlineAt: existing.qna_deadline_at,
          auctionAt: existing.auction_at,
        });

      if (unchanged) {
        return { event: null, tenderId: existing.id, version: existing.version };
      }

      await trx(TABLE)
        .where({ id: existing.id })
        .update({ ...row, version: existing.version + 1, is_latest: true });

      const ledger = await replaceLedger(trx, {
        source,
        tenderId: existing.id,
        lots,
        currency: tender.currency,
        awardedAt: tender.auctionAt,
      });

      return {
        event: 'TenderAmended',
        tenderId: existing.id,
        version: existing.version + 1,
        changedFields: changedKeys(existing, row),
        ...ledger,
      };
    });
  }
}
