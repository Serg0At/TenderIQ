import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';
import { significantPrefix } from '../libs/cpv.js';
import { stableHash } from '../utils/hash.js';
import parties from './party.repo.js';
import tenderSources from './tenderSource.repo.js';

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
 * A set of CPV codes in its stored form: each once, in order. A set, not a
 * list — the order a page happens to print them in is not a fact about the
 * tender, and must not read as an amendment when it moves.
 */
const codeSet = (codes) => [...new Set((codes ?? []).filter(Boolean).map(String))].sort();

const sameCodes = (a, b) => codeSet(a).join() === codeSet(b).join();

/**
 * A tender holds one document row per set it was issued, and an addendum is a
 * new set (ticket 18), so "the tender's invitation" is the newest row. The id
 * only breaks a tie — a CUID2 says nothing about order.
 */
const NEWEST_DOCUMENT_FIRST = [
  { column: 'stored_at', order: 'desc' },
  { column: 'id', order: 'desc' },
];

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
    cpvCodes: codeSet(tender.cpvCodes),
    procedureType: tender.procedureType,
    submissionChannel: tender.submissionChannel,
    goodsWorksServices: tender.goodsWorksServices,
    evaluationMethod: tender.evaluationMethod,
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
  cpv_codes: codeSet(tender.cpvCodes),
  procedure_type: tender.procedureType,
  submission_channel: tender.submissionChannel,
  goods_works_services: tender.goodsWorksServices ?? null,
  evaluation_method: tender.evaluationMethod ?? null,
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
  // which made an empty parse destructive: the e-auction board adding one column to
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
        initial_offer_net: bid.initialValue,
        final_offer_price: bid.finalPrice,
        final_offer_net: bid.finalValue,
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
          net_amount: bid.finalValue,
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
 * SQL twin of `normalizeCode` in services/resolution.service.js: «» and quotes
 * stripped, dashes made `-`, inner whitespace collapsed, uppercased. It only
 * narrows the candidates; the resolution module re-checks each one.
 *
 * The `և` replace is not cosmetic: JavaScript uppercases that ligature to
 * `ԵՒ` and Postgres leaves it alone, so without it a code such as
 * `ՀՀ ԱԱԾ-ՏԱևԿԿԳՎ-…` never reaches the candidates at all.
 */
const codeKeySql = (column) =>
  `upper(btrim(regexp_replace(regexp_replace(translate(replace(${column}, 'և', 'ԵՒ'), ` +
  `'‐‑‒–—―', '------'), '[«»"''“”„‘’]', '', 'g'), '\\s+', ' ', 'g')))`;

/**
 * Every code a tender states, as SQL over a `tenders` alias: the twin of
 * libs/cpv.js#tenderCodes — primary code, the tender's own list, every lot's —
 * so a filter in SQL reads the same list the matcher does. It may hold NULLs
 * and repeats, which `coversAnySql` is not disturbed by: a NULL starts with
 * nothing, and a repeat inside `exists` counts once.
 */
export const tenderCodesSql = (alias = 't') =>
  `(array[${alias}.cpv_code]::text[] || ${alias}.cpv_codes || ` +
  `array(select l.cpv_code::text from tender_lots l where l.tender_id = ${alias}.id))`;

/**
 * SQL twin of libs/cpv.js#covers: does any code the tender states start with
 * one of the bound `?::text[]` prefixes. A wanted code covers exactly the codes
 * that start with its `significantPrefix`, so the CPV filter binds those and
 * the field filter binds its field's prefixes, and both answer the matcher's
 * question. `starts_with` rather than `like`: a `%` or `_` in a filter value is
 * a character, not a wildcard. It moves with `covers`: change one, change both.
 */
const coversAnySql = (alias = 't') =>
  `exists (select 1 from unnest(${tenderCodesSql(alias)}) as c(code) ` +
  `join unnest(?::text[]) as p(prefix) on starts_with(c.code, p.prefix))`;

/** The columns every tender list selects. */
const LIST_COLUMNS = [
  't.id', 't.source_id', 't.title', 't.reference_code', 't.cpv_code', 't.cpv_codes',
  't.procedure_type', 't.submission_channel', 't.goods_works_services', 't.evaluation_method', 't.status', 't.source_status', 't.estimated_value',
  't.currency', 't.published_at', 't.deadline_at', 't.auction_at',
  'b.id as buyer_id', 'b.name as buyer_name', 'b.region as buyer_region',
];

/** A tender a supplier could still submit to. See CONTEXT.md, "Biddable tender". */
export const BIDDABLE_STATUSES = ['active', 'amended'];

/**
 * The Discovery filters, applied to a query over `tenders as t` joined to
 * `parties as b`. One function for both lists, so every filter the plain list
 * has, the relevant list has too, and they cannot drift.
 *
 * CPV matches any code the tender states — its primary code, every code its
 * source lists for it, or any lot's (`tenderCodesSql`). A tender whose lot 7 of
 * 18 is a supplier's category must surface for them, and so must one whose
 * page names a code no lot carries; reading fewer codes would silently hide
 * it. A missed tender is the product's #1 churn cause. Both CPV filters match
 * by the alert's rule (`coversAnySql`).
 */
const applyDiscoveryFilters = (query, {
  cpvCodes = [],
  keyword = null,
  buyerId = null,
  region = null,
  minValue = null,
  maxValue = null,
  procedureType = null,
  submissionChannels = [],
  status = null,
  deadlineAfter = null,
  deadlineBefore = null,
  purchaseKindLabels = [],
  cpvPrefixes = [],
} = {}) => {
  if (cpvCodes.length) {
    query.whereRaw(coversAnySql('t'), [cpvCodes.map(significantPrefix).filter(Boolean)]);
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
  if (submissionChannels.length) query.whereIn('t.submission_channel', submissionChannels);
  if (status) query.whereIn('t.status', Array.isArray(status) ? status : [status]);
  if (minValue !== null) query.where('t.estimated_value', '>=', minValue);
  if (maxValue !== null) query.where('t.estimated_value', '<=', maxValue);
  if (deadlineAfter) query.where('t.deadline_at', '>=', deadlineAfter);
  if (deadlineBefore) query.where('t.deadline_at', '<=', deadlineBefore);
  if (purchaseKindLabels.length) query.whereIn('t.goods_works_services', purchaseKindLabels);

  // A Field resolves to CPV prefixes — significant prefixes, or libs/fields.js
  // refuses to load — so it binds them as they are. A tender with no CPV
  // anywhere cannot match, and that is accepted rather than guessed from text.
  if (cpvPrefixes.length) query.whereRaw(coversAnySql('t'), [cpvPrefixes]);
  return query;
};

/**
 * Each tender's lots, grouped by lot number, as one JSON column: the lot's
 * distinct CPV codes, and which of `keywords` occur in its items' names.
 *
 * Keyword hits are computed here rather than by shipping the names: lot text
 * averages ~3,000 characters a tender, mostly specification paragraphs, and
 * carrying a megabyte of it per request to test a handful of substrings is the
 * whole cost of the query. `strpos` on `lower()` is a plain substring test —
 * the same reading the alert matcher gives a keyword — and, unlike ILIKE,
 * treats `%` and `_` in a keyword as the characters they are.
 */
const lotsColumn = (trx, keywords) =>
  trx.raw(
    `(select coalesce(json_agg(x order by x.lot_number), '[]'::json) from (
        select l.lot_number,
               array_remove(array_agg(distinct l.cpv_code), null) as codes,
               array_remove(array_agg(distinct k.word), null) as keyword_hits
          from tender_lots l
          left join lateral unnest(?::text[]) as k(word)
            on k.word <> '' and strpos(lower(l.name), lower(k.word)) > 0
         where l.tender_id = t.id
         group by l.lot_number
      ) x) as lots`,
    [keywords]
  );

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
   * Only `is_latest` rows are returned, so an amended tender appears once, at
   * its current version. The filters themselves are `applyDiscoveryFilters`,
   * shared with the relevance candidates.
   */
  static async search({ limit = 20, cursor = null, ...filters } = {}, trx = db) {
    // Sort key coalesces NULL publish dates to -infinity so the row-value
    // cursor comparison stays valid instead of silently dropping them.
    const SORT = trx.raw("coalesce(t.published_at, '-infinity'::timestamp)");

    const query = trx(`${TABLE} as t`)
      .join('parties as b', 'b.id', 't.buyer_id')
      .where('t.is_latest', true)
      .select(...LIST_COLUMNS);

    applyDiscoveryFilters(query, filters);

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

  /**
   * The tenders relevance orders: every match for the Discovery filters, with
   * their lots (codes, and which of `keywords` their names contain), unpaged — the ranking is computed over the whole set per
   * request and paged afterwards.
   *
   * Only BIDDABLE tenders: current, with a deadline still ahead or none at all
   * — a notice missing its deadline is not silently dropped — and, by default,
   * active or amended. An explicit status filter from the caller replaces the
   * status default; the deadline guard always holds.
   *
   * Returns `{ rows, overflow }`: `overflow` is true when more than `cap`
   * tenders matched, and then `rows` is empty. Ranking a truncated set would
   * present the best of an arbitrary slice as the best of everything.
   */
  static async findRankable({ biddableAt, cap, keywords = [], ...filters }, trx = db) {
    const query = trx(`${TABLE} as t`)
      .join('parties as b', 'b.id', 't.buyer_id')
      .where('t.is_latest', true)
      .select(...LIST_COLUMNS, lotsColumn(trx, keywords));

    applyDiscoveryFilters(query, filters);

    // Biddable always means the deadline is still ahead (or absent). An explicit
    // status filter only narrows WHICH open statuses count; it never reaches
    // past a deadline — the list is "tenders I could still bid on".
    if (!filters.status) query.whereIn('t.status', BIDDABLE_STATUSES);
    query.andWhere((q) => q.whereNull('t.deadline_at').orWhere('t.deadline_at', '>', biddableAt));

    const rows = await query.limit(cap + 1);
    if (rows.length > cap) return { rows: [], overflow: true };
    return { rows, overflow: false };
  }

  /**
   * The tenders that were biddable at a past moment `at`, with their lots — for
   * the relevance backtest. Statuses have moved on since, so "biddable then" is
   * read from dates alone: published by `at`, deadline still ahead of it. A
   * tender with no deadline is left out here, since there is no telling whether
   * it was still open; the live list keeps them.
   */
  static async findBiddableAsOf(at, trx = db) {
    return trx(`${TABLE} as t`)
      .join('parties as b', 'b.id', 't.buyer_id')
      .where('t.is_latest', true)
      .andWhere('t.published_at', '<=', at)
      .andWhere('t.deadline_at', '>', at)
      .select(...LIST_COLUMNS, lotsColumn(trx, []));
  }

  /**
   * Tenders with no CPV code list recorded, keyset by id — the ones stored
   * before `cpv_codes` existed, for the backfill from storage. A tender whose
   * source states no code at all stays in this set; that is what it states.
   */
  static async findWithoutCpvCodes({ afterId = null, limit = 200 } = {}, trx = db) {
    const query = trx(TABLE).whereRaw('cardinality(cpv_codes) = 0').orderBy('id').limit(limit);
    if (afterId) query.where('id', '>', afterId);
    return query.select('id', 'source_id');
  }

  /**
   * Record a tender's code list where none is recorded yet. A blank only, so
   * the backfill can never overwrite what a live fetch wrote since it read the
   * row. Writes the column and nothing else: no version, no event, no alert.
   */
  static async fillCpvCodes(id, codes, trx = db) {
    const list = codeSet(codes);
    if (!list.length) return false;
    const updated = await trx(TABLE).where({ id }).whereRaw('cardinality(cpv_codes) = 0').update({ cpv_codes: list });
    return updated > 0;
  }

  /** Full detail for one tender, including its lots, documents and source links. */
  static async findDetail(id, trx = db) {
    const tender = await trx(`${TABLE} as t`)
      .join('parties as b', 'b.id', 't.buyer_id')
      .where('t.id', id)
      .select('t.*', 'b.name as buyer_name', 'b.tax_id as buyer_tax_id', 'b.region as buyer_region')
      .first();
    if (!tender) return null;

    const [lots, documents, sources] = await Promise.all([
      trx('tender_lots').where({ tender_id: id }).orderBy('lot_number').select('lot_number', 'cpv_code', 'name'),
      trx('tender_documents').where({ tender_id: id }).orderBy('id').select('id', 'kind', 'url', 'parsed', 'manifest'),
      tenderSources.listForTender(id, trx),
    ]);

    return { ...tender, lots, documents, sources };
  }


  /**
   * One stored document of one tender, for serving a file out of it.
   *
   * Scoped by BOTH ids, so a document id paired with the wrong tender is a
   * miss — the route names a tender, and a file must not be reachable under a
   * tender it does not belong to.
   */
  static async findDocument(tenderId, documentId, trx = db) {
    return trx('tender_documents')
      .where({ id: documentId, tender_id: tenderId })
      .first('id', 'tender_id', 'kind', 'storage_key', 'manifest');
  }

  /**
   * One tender's stored documents with their storage keys, for a worker that
   * reads them out of the bucket.
   *
   * Its own method rather than a column on `findDetail`: that one serves the
   * API, and a storage key is an internal address that must not reach a
   * response just to feed a worker. The AI checklist read the key off
   * `findDetail` until the file list narrowed its select, and from then on
   * found no document for every tender without anything failing.
   *
   * Newest first, so the first invitation is the one the tender holds now.
   */
  static async findWithStoredDocuments(tenderId, trx = db) {
    const tender = await trx(TABLE).where({ id: tenderId }).first('id', 'title');
    if (!tender) return null;
    const documents = await trx('tender_documents')
      .where({ tender_id: tenderId })
      .orderBy(NEWEST_DOCUMENT_FIRST)
      .select('id', 'kind', 'storage_key');
    return { ...tender, documents };
  }

  /**
   * The invitation a tender holds now, without its text: what a checklist's
   * `document_hash` is compared with on every read.
   */
  static async findCurrentInvitation(tenderId, trx = db) {
    return trx('tender_documents')
      .where({ tender_id: tenderId, kind: 'invitation' })
      .orderBy(NEWEST_DOCUMENT_FIRST)
      .first('id', 'text_hash');
  }

  /**
   * Stored documents whose file list was never taken — every row written
   * before `manifest` existed, and any whose archive could not be listed.
   * Keyset by id so a long run can resume, and so a row that fails again is
   * passed over rather than re-selected forever.
   */
  static async findDocumentsWithoutManifest({ afterId = null, limit = 100 } = {}, trx = db) {
    const query = trx('tender_documents').whereNull('manifest').orderBy('id').limit(limit);
    if (afterId) query.where('id', '>', afterId);
    return query.select('id', 'tender_id', 'kind', 'storage_key');
  }

  /** Fills a blank only: a listed archive never changes, so neither does its list. */
  static async setDocumentManifest(id, manifest, trx = db) {
    return trx('tender_documents')
      .where({ id })
      .whereNull('manifest')
      .update({ manifest: JSON.stringify(manifest) });
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
  static async findMissingInvitationDocuments({ source = 'eauction', limit = 500 }, trx = db) {
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
  static async rebuildAwardsFromBids({ source = 'eauction' } = {}) {
    return db.transaction(async (trx) => {
      const before = Number((await trx('awards').where({ source }).count('* as c').first()).c);

      await trx('awards').where({ source }).del();

      // DISTINCT ON keeps the first row per (tender, lot) after ordering by
      // rank — Postgres doing the winner selection in one pass.
      const inserted = await trx.raw(
        `INSERT INTO awards (id, tender_id, lot_number, supplier_id, amount, net_amount, estimated_value, currency, awarded_at, status, source)
         SELECT DISTINCT ON (b.tender_id, b.lot_number)
                substr(md5(random()::text || b.id), 1, 24),
                b.tender_id, b.lot_number, b.supplier_id,
                b.final_offer_price, b.final_offer_net, b.budget_price, b.currency,
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
   * The candidate tenders for one observation, answering exactly the lookups
   * `resolution.service.js#lookupsFor` asked for. Deciding between them is the
   * resolution module's job, never this one's: the code lookup may return more
   * than one run, and that is the point.
   */
  static async findCandidates({ link, pointer, code }, trx = db) {
    const candidates = (query) =>
      query.select(
        't.id', 't.status', 't.reference_code', 't.submission_channel', 't.published_at', 't.deadline_at',
        trx.raw(
          `array(select lot_number from tender_lots where tender_id = t.id
                 union
                 select lot_number from public_tender_bids where tender_id = t.id) as lot_numbers`
        )
      );
    const byLink = async (ref) =>
      ref
        ? candidates(
          trx(`${TABLE} as t`)
            .join('tender_sources as s', 's.tender_id', 't.id')
            .where({ 's.source': ref.source, 's.external_id': ref.externalId })
        )
        : [];
    const byCode = async () =>
      code
        ? candidates(
          trx(`${TABLE} as t`)
            .whereRaw(`${codeKeySql('t.reference_code')} = ?`, [code.key])
            .andWhere('t.submission_channel', code.submissionChannel)
        )
        : [];

    const toCandidate = (row) => ({
      id: row.id,
      status: row.status,
      referenceCode: row.reference_code,
      submissionChannel: row.submission_channel,
      publishedAt: row.published_at,
      deadlineAt: row.deadline_at,
      lotNumbers: row.lot_numbers ?? [],
    });
    const linked = await byLink(link);
    const pointed = await byLink(pointer);
    const coded = await byCode();
    return {
      linked: linked.map(toCandidate),
      pointed: pointed.map(toCandidate),
      byCode: coded.map(toCandidate),
    };
  }

  /**
   * Apply what the invitation archive revealed: the buyer's tax ID, the CPV
   * code, every CPV code it states, and a `tender_documents` row for the
   * archive itself.
   *
   * These three fields exist nowhere in the HTML — only inside hraver.docx —
   * so this is the only path that can ever populate them. One transaction, so
   * a tender never shows a CPV whose source document was not recorded.
   *
   * The tender row is locked, and its status, deadline and version returned,
   * so the caller can raise an addendum in the same transaction
   * (services/addendum.service.js) without racing the normalizer's version.
   */
  static async applyInvitationFacts({
    source = 'eauction',
    sourceId,
    kind = 'invitation',
    url,
    storageKey,
    taxId,
    cpvCode,
    cpvCodes = [],
    lots = [],
    manifest = null,
    textHash = null,
  }, trx = db) {
    const run = async (trx) => {
      const tender = await trx(TABLE).where({ source_id: sourceId }).forUpdate().first();
      if (!tender) return { skipped: 'unknown_tender' };

      // Only fills a blank: the detail page is authoritative for everything it
      // publishes, and re-running this must not churn `version`.
      if (cpvCode && !tender.cpv_code) {
        await trx(TABLE).where({ id: tender.id }).update({ cpv_code: cpvCode });
      }

      // Replaced, not filled: for a source whose codes live only in the archive
      // (e-auction), the archive is the authority on them, as it is on the lots
      // below — and only when something parsed, for the same reason. A source
      // whose page states its codes (armeps.am) passes none, and the page's
      // list stands.
      const codes = codeSet(cpvCodes);
      const codesReplaced = codes.length > 0 && !sameCodes(tender.cpv_codes, codes);
      if (codesReplaced) await trx(TABLE).where({ id: tender.id }).update({ cpv_codes: codes });

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
          kind,
          parsed: true,
          // Serialised by hand: knex hands a JS array to node-postgres as a
          // Postgres array literal, which jsonb rejects.
          manifest: manifest ? JSON.stringify(manifest) : null,
          text_hash: textHash,
        })
        .onConflict(['tender_id', 'storage_key'])
        .ignore();

      return {
        tenderId: tender.id,
        tender: { status: tender.status, deadlineAt: tender.deadline_at, version: tender.version },
        cpvSet: Boolean(cpvCode && !tender.cpv_code),
        codesReplaced,
        taxIdSet,
        lotsSeen: lots.length,
        lotsWritten,
        documentRecorded: (inserted?.rowCount ?? 0) > 0,
      };
    };
    return trx === db ? db.transaction(run) : run(trx);
  }

  /** The file list of one stored document of a tender, by its storage key. */
  static async findDocumentManifest(tenderId, storageKey, trx = db) {
    return trx('tender_documents').where({ tender_id: tenderId, storage_key: storageKey }).first('id', 'manifest');
  }

  /**
   * An addendum's version: one more, and the status the caller decided. The
   * same counter `saveNormalized` advances, under the row lock
   * `applyInvitationFacts` took, so the two never hand out one version twice.
   */
  static async recordAddendum(id, { status }, trx = db) {
    const [row] = await trx(TABLE)
      .where({ id })
      .update({ version: trx.raw('version + 1'), status })
      .returning('version');
    return row.version;
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
   * A detail source's links on tenders that have not settled, whether or not
   * their deadline has passed — the ARMEPS refresh. Its job is the opposite
   * case from findNeedingRefresh's: armeps.am can move a deadline while the
   * gnumner notice stays the same, so nothing else would ever re-read the
   * page before the deadline.
   *
   * Read through `tender_sources` rather than a `source_id` prefix: it is the
   * link that names the page to fetch. Stalest link first, so the batch cap
   * rotates through every open tender instead of re-reading the same few.
   *
   * A tender with no deadline is left out: nothing then bounds how long it
   * would be re-read, and an armeps.am CfT page always states one.
   */
  static async findUnsettledLinks({ source, windowDays, limit }, trx = db) {
    const floor = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    return trx(`${TABLE} as t`)
      .join('tender_sources as s', 's.tender_id', 't.id')
      .where('s.source', source)
      .whereNotIn('t.status', TERMINAL_STATUSES)
      .andWhere('t.deadline_at', '>', floor)
      .orderBy([{ column: 's.last_seen_at', order: 'asc' }, { column: 't.id', order: 'asc' }])
      .limit(limit)
      .select('t.id', 's.external_id', 't.status', 't.deadline_at', 's.last_seen_at');
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
   *
   * `link` is the `tender_sources` row for the page this came from. It is
   * written on every call, unchanged tenders included, in the same
   * transaction: a tender is never visible without the link that produced it,
   * and `last_seen_at` / `observed_status` follow every fetch that got this far.
   *
   * `tenderId` is the resolution module's decision: the tender this
   * observation links to, or null to create one under `sourceId`. Which tender
   * is never re-decided here. A linked tender deleted since it was resolved
   * throws, so the retry resolves again rather than resurrecting it.
   */
  static async saveNormalized({ source, sourceId, tenderId = null, buyerName, tender, lots, link }) {
    return db.transaction(async (trx) => {
      const buyerId = await parties.upsertBuyer({ source, name: buyerName }, trx);
      if (!buyerId) {
        // buyer_id is NOT NULL and there is no honest placeholder for it.
        // Skipping keeps the tender out until the page yields a real buyer.
        return { event: null, skipped: 'no_buyer' };
      }

      const existing = tenderId ? await trx(TABLE).where({ id: tenderId }).forUpdate().first() : null;
      if (tenderId && !existing) {
        throw new Error(`[tenders] resolved tender ${tenderId} no longer exists — re-resolve`);
      }
      // The detail page never carries a CPV; the invitation archive does, and
      // applyInvitationFacts writes it after this row exists. A detail with no
      // CPV is silence, not a change — treating it as one wiped every stored
      // code and re-notified each tender as amended on every replay.
      const candidate = {
        ...tender,
        // `amended` is an addendum's (services/addendum.service.js), written
        // under this row's lock. deriveStatus read the status before the lock
        // was taken, so an addendum that committed in between would be
        // reverted here — and alerted as a status change — without this.
        status: existing?.status === 'amended' && tender.status === 'active' ? 'amended' : tender.status,
        buyerId,
        cpvCode: tender.cpvCode ?? existing?.cpv_code ?? null,
        // Same silence for the full list: e-auction's comes from the archive.
        cpvCodes: tender.cpvCodes ?? existing?.cpv_codes ?? [],
      };
      const row = toRow(candidate, buyerId);

      // A tender stored before `cpv_codes` existed has an empty list, and the
      // page re-read now states its codes. Filling that blank is recording what
      // the tender always said, not a change: as an amendment it would
      // re-notify every matching organization about every old tender the first
      // time each was re-read after a deploy (ticket 17). A list that was
      // recorded and then moves is an amendment like any other field.
      const storedCodes = existing?.cpv_codes?.length ? existing.cpv_codes : row.cpv_codes;

      if (!existing) {
        const id = createId();
        await trx(TABLE).insert({ ...row, id, source_id: sourceId, version: 1, is_latest: true });
        await tenderSources.upsert({ ...link, tenderId: id }, trx);
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
          cpvCodes: storedCodes,
          procedureType: existing.procedure_type,
          submissionChannel: existing.submission_channel,
          goodsWorksServices: existing.goods_works_services,
          evaluationMethod: existing.evaluation_method,
          status: existing.status,
          sourceStatus: existing.source_status,
          estimatedValue: existing.estimated_value === null ? null : String(existing.estimated_value),
          currency: existing.currency,
          publishedAt: existing.published_at,
          deadlineAt: existing.deadline_at,
          qnaDeadlineAt: existing.qna_deadline_at,
          auctionAt: existing.auction_at,
        });

      await tenderSources.upsert({ ...link, tenderId: existing.id }, trx);

      if (unchanged) {
        if (!sameCodes(existing.cpv_codes, row.cpv_codes)) {
          await trx(TABLE).where({ id: existing.id }).update({ cpv_codes: row.cpv_codes });
        }
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
        changedFields: changedKeys({ ...existing, cpv_codes: storedCodes }, row),
        ...ledger,
      };
    });
  }
}
