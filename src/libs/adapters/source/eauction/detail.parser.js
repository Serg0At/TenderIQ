import * as cheerio from 'cheerio';

/**
 * Pure HTML -> data. No network, no database, no config, no clock.
 *
 * Verified against live pages on 2026-08-16:
 *   active   https://eauction.armeps.am/hy/public/tender_details/tid/46895/  (7.9 KB)
 *   finished https://eauction.armeps.am/hy/public/tender_details/tid/39840/  (77 KB)
 *
 * The page is a flat list of label/value pairs in two interchangeable class
 * families:
 *
 *   <div class="w_40 de_g"><div class="de_t">Գնորդ</div><div class="de_v">NAME</div></div>
 *   <div class="w_40 fe_g"><div class="fe_t">Հրավեր</div><div class="fe_v"><a …></div></div>
 *
 * A *finished* tender additionally renders the "Գնառաջարկներ" bid ledger —
 * every lot, every bidder, the estimated price and the winning offer. That
 * table is the only public source for suppliers, award amounts and estimated
 * value; none of it exists on an active tender or anywhere in the listing.
 */

const AM_UTC_OFFSET = '+04:00';

const toDate = (value) => {
  if (!value) return null;
  const match = String(value).match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  if (!match) return null;
  const date = new Date(`${match[0].replace(' ', 'T')}${AM_UTC_OFFSET}`);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * "360000 AMD" / "165000.00 AMD " -> 165000. Null on anything unrecognised.
 *
 * Deliberately strict about separators. A lenient leading-digits match reads
 * "165,000.00" as 165 — understating a benchmark price 1000x, silently, with no
 * way to tell the result from a genuinely small bid. Comma grouping is accepted
 * only in a well-formed position; anything else returns null so the row is
 * visibly missing rather than quietly wrong.
 */
const toAmount = (value) => {
  const cleaned = String(value ?? '')
    .replace(/[\s ]/g, '')
    .replace(/(?:AMD|֏|դրամ)/gi, '');
  if (!cleaned) return null;

  const plain = /^-?\d+(?:\.\d+)?$/;
  const grouped = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

  let token = null;
  if (plain.test(cleaned)) token = cleaned;
  else if (grouped.test(cleaned)) token = cleaned.replace(/,/g, '');
  else return null;

  const amount = Number(token);
  return Number.isFinite(amount) ? amount : null;
};

/** "20 %" -> 20 */
const toPercent = (value) => {
  const match = String(value ?? '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
};

/**
 * This subdomain hosts exactly one procurement method — the electronic reverse
 * auction, confirmed by the "Հակադարձ աճուրդ" field being present on every
 * tender. It is implied by the source, never scraped per row.
 *
 * The value is `e_auction` rather than a literal translation because
 * `procedure_type` is a closed domain enum (open | quotation | single_source |
 * e_auction | restricted). Inventing `reverse_auction` would put a value in the
 * column that no downstream filter, facet or benchmark knows how to read.
 */
export const PROCEDURE_TYPE = 'e_auction';

/**
 * Site status -> the `tenders.status` domain enum.
 *
 * All ten were observed across 450 rows on 15 listing pages (2026-08-16) and
 * confirmed to use the same vocabulary on detail pages. An earlier revision
 * mapped only five, which dead-lettered the entire middle of the lifecycle —
 * 18 of 30 tenders on page 8 — because the normalizer refuses to persist a
 * status it cannot map.
 *
 * The domain enum has six values and the source has ten, so six site states
 * collapse into `closed`. That is lossy for the UI: "pre-auction" and "auction
 * in progress" are meaningfully different to a supplier watching a tender. The
 * Armenian original is therefore preserved verbatim on the tender as
 * `source_status`, and the raw payload is retained in storage regardless.
 *
 * The dividing line for `active` is "can a supplier still submit a bid?" — only
 * Հրապարակված qualifies. Everything from Նախաաճուրդային onward has closed
 * submission, even though the procedure is still running.
 *
 * Փոփոխված is the eleventh label and is not here: see SUPERSEDED_STATUS.
 */
const STATUS = {
  Հրապարակված: 'active', // published, accepting bids
  Նախաաճուրդային: 'closed', // pre-auction: bids in, auction pending
  Աճուրդ: 'closed', // auction in progress
  'Դիմում-Հայտարարության գնահատում': 'closed', // bid evaluation
  'Մինչև Դիմում-Հայտարարության շտկման գնահատում': 'closed', // pre-correction evaluation
  'Դիմում-Հայտարարության շտկման գնահատում': 'closed', // correction evaluation
  Շնորհում: 'closed', // awarding in progress
  Ավարտված: 'awarded', // completed, winner determined
  Չկայացած: 'cancelled', // did not take place (no valid bids)
  Չեղարկված: 'cancelled', // withdrawn by the buyer
};

/**
 * Returns null for an unrecognised status rather than guessing. The caller
 * decides what to do — see the normalizer, which degrades to a deadline-derived
 * status and warns, instead of discarding an otherwise complete tender over one
 * unknown label.
 */
export const mapStatus = (raw) => STATUS[String(raw ?? '').trim()] ?? null;

/**
 * "Amended" — and deliberately NOT in STATUS, because it is a fact about this
 * run, not about the tender. An e-auction amendment is published as a new tid
 * whose page names this one as its predecessor (see `predecessorsOf`); this
 * page is then a dead run, off the listing for good, and the tender's status is
 * the replacement's to say (ticket 29).
 */
const SUPERSEDED_STATUS = 'Փոփոխված';

/**
 * The tids this page replaced, from «Աճուրդի սկզբնական հրավեր(ներ)»: a table
 * of code, publish time and a `tender_details/tid/N/` link per predecessor.
 * Only the current run carries it, and it lists every run before it — 46964
 * names both 46826 and 46963 — while a superseded page shows none. Verified
 * 2026-10-21: of 90 stored pages with the block, 84 hold the amendment notice
 * (`popoxutyan_pastatuxt.*`) in their archive; the six re-announced codes of
 * ADR 0004 carry no block, so the pointer, not the code, is what makes an
 * amendment.
 */
const PREDECESSOR_LABEL = 'Աճուրդի սկզբնական հրավեր(ներ)';
const TID_RE = /\/tender_details\/tid\/(\d+)\//;

const predecessorsOf = ($) => {
  const tids = new Set();
  valueOf($, PREDECESSOR_LABEL)
    .find('a[href]')
    .each((_, a) => {
      const tid = ($(a).attr('href') || '').match(TID_RE)?.[1];
      if (tid) tids.add(tid);
    });
  return [...tids].sort((a, b) => Number(a) - Number(b));
};

/**
 * Returns the value node for a label, or an empty selection.
 *
 * An earlier revision walked every element in the document comparing own-text,
 * because the DOM had not been confirmed. It has been now, so this is a plain
 * two-class selector: ~40x cheaper and it fails visibly rather than silently
 * matching some unrelated node whose text happens to equal the label.
 */
const valueOf = ($, label) => {
  let node = $();
  $('.de_t, .fe_t').each((_, el) => {
    const $el = $(el);
    if ($el.text().trim() !== label) return undefined;
    node = $el.next('.de_v, .fe_v');
    return false;
  });
  return node;
};

const textOf = ($, label) => {
  const node = valueOf($, label);
  if (!node.length) return null;
  const text = node.text().trim().replace(/\s+/g, ' ');
  return text || null;
};

const linkOf = ($, label) => valueOf($, label).find('a[href]').first().attr('href') || null;

const absolute = (href, baseUrl) => {
  if (!href) return null;
  if (!baseUrl) return href;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
};

/** Supplier id out of `/hy/procurer/bo_details/tid/<tender>/id/<supplier>/`. */
const SUPPLIER_ID_RE = /\/bo_details\/tid\/\d+\/id\/(\d+)/;

/**
 * The "Գնառաջարկներ" ledger, one row per (lot, bidder).
 *
 * Column order, from the two-row header:
 *   0 lot | 1 rank | 2 bidder | 3 estimated price
 *   4,5,6 initial offer: value, VAT %, price
 *   7,8,9 final offer:   value, VAT %, price
 *   10 participant status
 *
 * Rows with a different cell count are counted into `malformedRows` rather than
 * guessed at, so a column being added shows up as a reported fault instead of
 * silently shifted money — the one failure mode that would poison every
 * benchmark downstream. The normalizer refuses to persist a ledger that parsed
 * to nothing while malformed rows were seen.
 */
const EXPECTED_LEDGER_CELLS = 11;

const parseBidLedger = ($, baseUrl) => {
  const heading = $('h3')
    .filter((_, el) => $(el).text().trim() === 'Գնառաջարկներ')
    .first();
  if (!heading.length) return { lots: [], malformedRows: 0 };

  const table = heading.nextAll('table').first();
  if (!table.length) return { lots: [], malformedRows: 0 };

  /**
   * The same "Գնառաջարկներ" heading sits above TWO different tables depending
   * on where the tender is in its lifecycle:
   *
   *   Նախաաճուրդային / Աճուրդ -> a 5-column auction SCHEDULE
   *      (Հ/հ | Չափաբաժնի համար | անվանում | Աճուրդի մեկնարկային գին | Մեկնարկ)
   *   evaluation onward       -> the 11-column bid LEDGER parsed below
   *
   * Identifying the ledger by its header rather than by cell count matters:
   * treating the schedule as a reshaped ledger reported 38 malformed rows on a
   * perfectly healthy pre-auction tender, which the normalizer would then
   * refuse to persist. No ledger yet is a normal state, not a fault.
   */
  const header = table.find('tr').first().text().replace(/\s+/g, ' ');
  const isLedger = header.includes('Զբաղեցրած տեղ') || header.includes('Ներկայացված հայտեր');
  if (!isLedger) return { lots: [], malformedRows: 0 };

  const byLot = new Map();
  let malformedRows = 0;

  // Header rows are excluded by selector rather than by cell count, so that a
  // wrong cell count on a DATA row is a reportable fault instead of being
  // silently indistinguishable from a heading.
  table.find('tr').each((_, tr) => {
    const $tr = $(tr);
    if ($tr.closest('thead').length) return;

    const cells = $tr.find('td');
    if (cells.length === 0) return;
    if (cells.length !== EXPECTED_LEDGER_CELLS) {
      // The column count moved. Counted, not guessed at — reading money out of
      // shifted columns would poison every benchmark computed from it.
      malformedRows += 1;
      return;
    }

    const lotNumber = Number.parseInt(cells.eq(0).text().trim(), 10);
    const rank = Number.parseInt(cells.eq(1).text().trim(), 10);
    if (!Number.isFinite(lotNumber)) {
      malformedRows += 1;
      return;
    }

    const $bidder = cells.eq(2);
    const $supplierLink = $bidder.find('a[href*="bo_details"]').first();
    const supplierHref = $supplierLink.attr('href') || '';
    const supplierId = supplierHref.match(SUPPLIER_ID_RE)?.[1] ?? null;
    const supplierName = $supplierLink.text().trim().replace(/\s+/g, ' ') || null;

    // The bidder cell also carries the bid's own application archive.
    const applicationUrl =
      $bidder
        .find('a[href*="/documents/application/"]')
        .first()
        .attr('href') || null;

    if (!byLot.has(lotNumber)) {
      byLot.set(lotNumber, {
        lotNumber,
        estimatedValue: toAmount(cells.eq(3).text()),
        bids: [],
      });
    }

    byLot.get(lotNumber).bids.push({
      rank: Number.isFinite(rank) ? rank : null,
      supplierSourceId: supplierId,
      supplierName,
      applicationUrl: absolute(applicationUrl, baseUrl),
      initialValue: toAmount(cells.eq(4).text()),
      initialVatPercent: toPercent(cells.eq(5).text()),
      initialPrice: toAmount(cells.eq(6).text()),
      finalValue: toAmount(cells.eq(7).text()),
      finalVatPercent: toPercent(cells.eq(8).text()),
      finalPrice: toAmount(cells.eq(9).text()),
      participantStatus: cells.eq(10).text().trim() || null,
    });
  });

  const lots = [...byLot.values()].sort((a, b) => a.lotNumber - b.lotNumber);
  for (const lot of lots) lot.bids.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  return { lots, malformedRows };
};

export const parseDetail = (html, { baseUrl } = {}) => {
  const $ = cheerio.load(html);

  const rawStatus = textOf($, 'Կարգավիճակ');
  const { lots, malformedRows } = parseBidLedger($, baseUrl);

  // Per-lot estimates roll up to the tender-level figure the schema stores.
  // Null (not 0) when no lot published one, so "no data" stays distinguishable
  // from "free of charge".
  const lotEstimates = lots.map((lot) => lot.estimatedValue).filter((v) => v !== null);
  const estimatedValue = lotEstimates.length
    ? lotEstimates.reduce((sum, v) => sum + v, 0)
    : null;

  return {
    code: textOf($, 'Ծածկագիր'),
    title: textOf($, 'Վերնագիր'),
    buyerName: textOf($, 'Գնորդ'),
    goodsWorksServices: textOf($, 'Գնման տեսակ'), // Ապրանք | Աշխատանք | Ծառայություն
    procedureType: PROCEDURE_TYPE,
    status: mapStatus(rawStatus),
    rawStatus,
    superseded: String(rawStatus ?? '').trim() === SUPERSEDED_STATUS,
    predecessors: predecessorsOf($),
    publishedAt: toDate(textOf($, 'Հրապարակման ժամանակ')),
    deadlineAt: toDate(textOf($, 'Հայտերի ընդունման վերջնաժամկետ')),
    auctionAt: toDate(textOf($, 'Հակադարձ աճուրդ')),
    qnaDeadlineAt: toDate(textOf($, 'Դուք կարող եք ուղարկել հարցում նախքան')),
    invitationUrl: absolute(linkOf($, 'Հրավեր'), baseUrl),
    protocolUrl: absolute(linkOf($, 'Արձանագրություն'), baseUrl),
    currency: 'AMD',
    estimatedValue,
    lots,
    // Layout-health signals, the detail-page equivalent of blocksSeen.
    labelsSeen: $('.de_t, .fe_t').length,
    malformedLedgerRows: malformedRows,
  };
};

export default { parseDetail, mapStatus, PROCEDURE_TYPE };
