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

      /**
       * The award goes to the best-ranked ACCEPTED bid, not simply to rank 1.
       *
       * The source ranks every submission including the ones it rejected
       * (`Մերժված`), and a lot whose rank-1 bidder was rejected is won by the
       * next valid bidder — or by nobody. Awarding on rank alone recorded 544
       * of 2,469 awards (22%) to companies the source had explicitly rejected,
       * including a bid of 6,666,600,000,000 AMD against a 75,000 budget that
       * the buyer had thrown out. That corrupts exactly what the awards table
       * exists for: who really won, and at what price.
       *
       * Bids arrive rank-sorted, so the first accepted one encountered per lot
       * is the winner. A lot with no accepted bid produces no award, which is
       * the honest reading of a failed lot.
       */
      const accepted = bid.participantStatus ? false : true;
      if (accepted && !awardedLots.has(lot.lotNumber)) {
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


/**
 * Opaque cursor: the exact sort key of the last row returned.
 *
 * Offset pagination silently repeats or skips rows when inserts land mid-scan,
 * and a feed of newly published tenders is exactly that case — the sweep writes
 * while a user pages. The id tiebreaker is not optional: two tenders published
 * in the same second would otherwise straddle a page boundary and one would be
 * lost.
 */
const encodeCursor = (row) =>
  Buffer.from(`${row.published_at ? new Date(row.published_at).toISOString() : ''}|${row.id}`).toString('base64url');

const decodeCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    return id ? { publishedAt: at || null, id } : null;
  } catch {
    return null;
  }
};

export default class TenderRepository {

  /**
   * Filtered, cursor-paginated tender search — the discovery query.
   *
   * CPV matches the tender headline code OR any of its lots. That is the whole
   * point of tender_lots: a tender whose lot 7 of 18 is a supplier's category
   * must surface for them, and matching only `tenders.cpv_code` would silently
   * hide it. A missed tender is the product's #1 churn cause.
   *
   * Only `is_latest` rows are returned, so an amended tender appears once, at
   * its current version.
   */
  static async search({
    cpvCodes = [],
    keyword = null,
    buyerId = null,
    region = null,
    minValue = null,
    maxValue = null,
    procedureType = null,
    status = null,
    deadlineAfter = null,
    deadlineBefore = null,
    purchaseKindLabels = [],
    cpvPrefixes = [],
    limit = 20,
    cursor = null,
  } = {}, trx = db) {
    // Sort key coalesces NULL publish dates to -infinity so the row-value
    // cursor comparison stays valid instead of silently dropping them.
    const SORT = trx.raw("coalesce(t.published_at, '-infinity'::timestamp)");

    const query = trx(`${TABLE} as t`)
      .join('parties as b', 'b.id', 't.buyer_id')
      .where('t.is_latest', true)
      .select(
        't.id', 't.source_id', 't.title', 't.reference_code', 't.cpv_code',
        't.procedure_type', 't.goods_works_services', 't.status', 't.source_status', 't.estimated_value',
        't.currency', 't.published_at', 't.deadline_at', 't.auction_at',
        'b.id as buyer_id', 'b.name as buyer_name', 'b.region as buyer_region'
      );

    if (cpvCodes.length) {
      query.where((q) =>
        q.whereIn('t.cpv_code', cpvCodes).orWhereExists((sub) =>
          sub.select(1).from('tender_lots as l').whereRaw('l.tender_id = t.id').whereIn('l.cpv_code', cpvCodes)
        )
      );
    }

    if (keyword) {
      // ILIKE rather than full-text search: Postgres ships no Armenian
      // dictionary, so a tsvector would only tokenise, not stem — and at this
      // corpus size a scan costs milliseconds. Revisit with a trigram index
      // when the archive is fully seeded.
      const like = `%${String(keyword).trim()}%`;
      query.where((q) =>
        q.whereILike('t.title', like).orWhereILike('t.reference_code', like).orWhereExists((sub) =>
          sub.select(1).from('tender_lots as l').whereRaw('l.tender_id = t.id').whereILike('l.name', like)
        )
      );
    }

    if (buyerId) query.where('t.buyer_id', buyerId);
    if (region) query.whereILike('b.region', `%${region}%`);
    if (procedureType) query.where('t.procedure_type', procedureType);
    if (status) query.whereIn('t.status', Array.isArray(status) ? status : [status]);
    if (minValue !== null) query.where('t.estimated_value', '>=', minValue);
    if (maxValue !== null) query.where('t.estimated_value', '<=', maxValue);
    if (deadlineAfter) query.where('t.deadline_at', '>=', deadlineAfter);
    if (deadlineBefore) query.where('t.deadline_at', '<=', deadlineBefore);
    if (purchaseKindLabels.length) query.whereIn('t.goods_works_services', purchaseKindLabels);

    // A Field resolves to CPV prefixes, matched on the headline code OR any lot —
    // the same reach as `cpvCodes` above, so the field filter is never a second,
    // narrower answer to "is this tender in my category". A tender with no CPV
    // anywhere cannot match, and that is accepted rather than guessed from text.
    if (cpvPrefixes.length) {
      const patterns = cpvPrefixes.map((prefix) => `${prefix}%`);
      query.where((q) =>
        q.whereRaw('t.cpv_code like any(?::text[])', [patterns]).orWhereExists((sub) =>
          sub.select(1).from('tender_lots as l').whereRaw('l.tender_id = t.id')
            .whereRaw('l.cpv_code like any(?::text[])', [patterns])
        )
      );
    }

    const after = decodeCursor(cursor);
    if (after) {
      query.whereRaw(`(coalesce(t.published_at, '-infinity'::timestamp), t.id) < (?, ?)`, [
        after.publishedAt ?? '-infinity',
        after.id,
      ]);
    }

    // One extra row answers "is there a next page?" without a second count
    // query, which on a filtered scan would cost as much as the page itself.
    const rows = await query.orderBy([{ column: SORT, order: 'desc' }, { column: 't.id', order: 'desc' }]).limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return { rows: page, cursor: page.length ? encodeCursor(page[page.length - 1]) : null, hasMore };
  }

  /** Full detail for one tender, including its lots. */
  static async findDetail(id, trx = db) {
    const tender = await trx(`${TABLE} as t`)
      .join('parties as b', 'b.id', 't.buyer_id')
      .where('t.id', id)
      .select('t.*', 'b.name as buyer_name', 'b.tax_id as buyer_tax_id', 'b.region as buyer_region')
      .first();
    if (!tender) return null;

    const [lots, documents] = await Promise.all([
      trx('tender_lots').where({ tender_id: id }).orderBy('lot_number').select('lot_number', 'cpv_code', 'name'),
      trx('tender_documents').where({ tender_id: id }).select('kind', 'url', 'parsed'),
    ]);

    return { ...tender, lots, documents };
  }


  /**
   * Tenders whose invitation archive was never fetched.
   *
   * The document stage is triggered by the normalizer, and only when a tender
   * actually CHANGED (`result.event`). That leaves two permanent gaps:
   *
   *   1. A settled tender never changes again, so it emits no further event —
   *      nothing will ever enqueue its invitation.
   *   2. The historical seed skips archives entirely while `backfillDocuments`
   *      is false, so every tender it ingests starts with no CPV and no buyer
   *      tax ID.
   *
   * Neither self-heals, and both look identical in the data to "this tender has
   * no CPV". This query is how those get picked up deliberately — the same
   * shape as findNeedingRefresh, driven from the database rather than from the
   * board.
   */
  static async findMissingInvitationDocuments({ source = 'armeps', limit = 500 }, trx = db) {
    return trx(`${TABLE} as t`)
      .leftJoin('tender_documents as d', 'd.tender_id', 't.id')
      .whereNotNull('t.invitation_url')
      .whereNull('d.id')
      .andWhere('t.source_id', 'like', `${source}:%`)
      // Newest first: recent tenders are the ones a supplier might still act
      // on, so they get their category filled in first.
      .orderBy('t.published_at', 'desc')
      .limit(limit)
      .select('t.id', 't.source_id', 't.invitation_url');
  }


  /**
   * Rebuild `awards` from the stored bid ledger.
   *
   * A repair path, not part of normal ingestion. Awards used to be written for
   * whichever bid ranked 1, including bids the source had rejected — so 22% of
   * them named the wrong company at an invalid price. Fixing the writer only
   * helps tenders that change again, and a settled tender never does.
   *
   * `public_tender_bids` already stores rank AND accept/reject status for every
   * bid, so the correct winner can be recomputed entirely from the database —
   * no re-crawl, no re-parse. The winner is the lowest-ranked accepted bid per
   * lot; a lot with no accepted bid yields no award.
   */
  static async rebuildAwardsFromBids({ source = 'armeps' } = {}) {
    return db.transaction(async (trx) => {
      const before = Number((await trx('awards').where({ source }).count('* as c').first()).c);

      await trx('awards').where({ source }).del();

      // DISTINCT ON keeps the first row per (tender, lot) after ordering by
      // rank — Postgres doing the winner selection in one pass.
      const inserted = await trx.raw(
        `INSERT INTO awards (id, tender_id, lot_number, supplier_id, amount, estimated_value, currency, awarded_at, status, source)
         SELECT DISTINCT ON (b.tender_id, b.lot_number)
                substr(md5(random()::text || b.id), 1, 24),
                b.tender_id, b.lot_number, b.supplier_id,
                b.final_offer_price, b.budget_price, b.currency,
                t.auction_at, 'awarded', b.source
           FROM public_tender_bids b
           JOIN tenders t ON t.id = b.tender_id
          WHERE b.source = ?
            AND b.status = 'accepted'
            AND b.supplier_id IS NOT NULL
          ORDER BY b.tender_id, b.lot_number, b.rank ASC NULLS LAST`,
        [source]
      );

      const after = Number((await trx('awards').where({ source }).count('* as c').first()).c);
      return { before, after, rebuilt: inserted.rowCount ?? after };
    });
  }

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
  static async applyInvitationFacts({ source = 'armeps', sourceId, url, storageKey, taxId, cpvCode, lots = [] }) {
    return db.transaction(async (trx) => {
      const tender = await trx(TABLE).where({ source_id: sourceId }).first();
      if (!tender) return { skipped: 'unknown_tender' };

      // Only fills a blank: the detail page is authoritative for everything it
      // publishes, and re-running this must not churn `version`.
      if (cpvCode && !tender.cpv_code) {
        await trx(TABLE).where({ id: tender.id }).update({ cpv_code: cpvCode });
      }

      const taxIdSet = taxId ? await parties.setTaxId(tender.buyer_id, taxId, trx) : false;

      // Replace rather than merge: the invitation lists the lots in full, so it
      // is authoritative, and a lot removed by an addendum must disappear here
      // too. Only when something parsed — an empty result means the lot table
      // moved, not that the tender lost its lots.
      //
      // Collapsed on the storage key rather than left to the unique index. The
      // invitation prints most lots twice, in a summary table and a detail
      // table, and the two can disagree; the parser deliberately keeps both.
      // Letting that reach Postgres makes a disagreement a 23505 that aborts
      // this transaction and loses the CPV, the tax ID and the document row
      // along with the lots. Last one wins instead.
      const rows = new Map();
      for (const lot of lots) {
        if (!Number.isFinite(lot.lotNumber)) continue;
        const itemSequence = Number.isFinite(lot.itemSequence) ? lot.itemSequence : 0;
        rows.set(`${lot.lotNumber}:${itemSequence}`, {
          id: createId(),
          tender_id: tender.id,
          lot_number: lot.lotNumber,
          cpv_code: lot.cpvCode ?? null,
          item_sequence: itemSequence,
          name: lot.name ?? null,
          source,
        });
      }

      const lotsWritten = rows.size;
      if (lotsWritten) {
        await trx('tender_lots').where({ tender_id: tender.id, source }).del();
        await trx('tender_lots').insert([...rows.values()]);
      }

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
        lotsSeen: lots.length,
        lotsWritten,
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
