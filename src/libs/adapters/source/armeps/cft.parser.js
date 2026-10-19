import * as cheerio from 'cheerio';

/**
 * Pure HTML -> data. No network, no database, no config, no clock.
 *
 * The armeps.am (European Dynamics e-PPS) "Notice & Contract Documents" page
 * of one call for tenders, reached only by `resourceId`:
 *   https://armeps.am/epps/cft/listContractDocuments.do?resourceId=12315509
 * Verified 2026-10-20 against 12315509 (quotation, works, no lots), 12542029
 * (open, supplies, 2 lots) and 12543933 (quotation, services). Served in
 * English to a client with no session, which is what the worker is.
 *
 * Two parts are read:
 *
 *   <div id="MoreCFTInfo"><dl class="Grid">
 *     <dt>Name of Contracting Authority:</dt> <dd><a …>NAME</a></dd>
 *     <dt>CfT Id:</dt> <dd>ԱՄՄՀ-ԳՀԱՇՁԲ-26/30</dd> …
 *   </dl></div>
 *
 *   <table id="T02"> one row per document: addendum, title, file (an
 *     onclick="downloadDocForAnonymous(<documentId>)" link), description, language
 *
 * There are no bidders, no prices and no status on this page — results are
 * PPCM's (ticket 10). "Estimated value" and "Date of Awarding" are blank even
 * on an awarded tender, so neither is ever evidence of anything.
 */

const AM_UTC_OFFSET = '+04:00';

/**
 * The page with the parts that change on every request removed, so that an
 * unchanged tender hashes the same twice. Two fetches a minute apart differ
 * in exactly these: the `jsessionid` in every link, the clock in the search
 * bar and the server-side pager key the sort script carries (`masterKey`);
 * across days also the calendar in the side menu and the footer's "Last
 * update". None of it is about the tender, and no field or document row is
 * touched.
 *
 * This is what gets stored, not only what gets hashed: the key's hash is then
 * the sha256 of the bytes behind it, the property every storage-key check
 * relies on. Without it each fetch would store a new payload and queue a
 * normalize for a page that had not changed.
 */
export const canonicalPage = (html) =>
  String(html)
    // Base64-like, `+` included (`;jsessionid=JAudcb-u+BFsBsY0Q__`), so it is
    // taken up to whatever ends the path rather than by character class.
    .replace(/;jsessionid=[^?#"'\s<>]+/g, '')
    .replace(/(\.masterKey\.value=)"[^"]*"/g, '$1""')
    .replace(/<p class="Time">[\s\S]*?<\/p>/, '<p class="Time"></p>')
    .replace(/<div id="Navigation">[\s\S]*?<!-- Navigation -->/, '<div id="Navigation"></div><!-- Navigation -->')
    .replace(/<p id="UpdateInfo">[\s\S]*?<\/p>/, '<p id="UpdateInfo"></p>');

/**
 * A CfT page, as opposed to what the site answers for an id that does not
 * exist or is not public: a 200 carrying the "you must log in" home page.
 */
export const isCftPage = (html) => cheerio.load(html)('#MoreCFTInfo dl.Grid').length > 0;

/** "28/07/2026 15:00" (Yerevan) -> Date. */
const toDate = (value) => {
  const match = String(value ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, day, month, year, hour, minute] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:00${AM_UTC_OFFSET}`);
  return Number.isNaN(date.getTime()) ? null : date;
};

const allDates = (value) =>
  [...String(value ?? '').matchAll(/\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}/g)].map((m) => toDate(m[0]));

/** Same strictness as eauction's: "165,000.00" is 165000, never 165. */
const toAmount = (value) => {
  const cleaned = String(value ?? '').replace(/[\s ]/g, '');
  if (!cleaned) return null;
  if (/^\d+(?:\.\d+)?$/.test(cleaned)) return Number(cleaned);
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(cleaned)) return Number(cleaned.replace(/,/g, ''));
  return null;
};

/**
 * "Procedure:" -> the `procedure_type` enum. Matched on words rather than the
 * whole label, because e-PPS qualifies them ("Open Tendering Urgent" is what
 * PPCM calls one). A label none of these fit returns null and the observation
 * refuses the page: a procedure type cannot be guessed, and the failed job
 * names the label to add.
 */
const PROCEDURE_RULES = [
  [/quotation/i, 'quotation'],
  [/restricted/i, 'restricted'],
  [/negotiat|single[\s-]?source/i, 'single_source'],
  [/\bopen\b/i, 'open'],
];

export const procedureTypeOf = (label) =>
  PROCEDURE_RULES.find(([pattern]) => pattern.test(label ?? ''))?.[1] ?? null;

/**
 * "Procurement Type:" -> the Armenian label eauction stores in
 * `goods_works_services`, so the purchase-kind filter (libs/purchaseKinds.js)
 * reads both sources from one column without a second vocabulary.
 */
const PURCHASE_KIND_LABELS = { supplies: 'Ապրանք', works: 'Աշխատանք', services: 'Ծառայություն' };

/**
 * "Evaluation Mechanism:" as a stable code: "Lowest Price" -> `lowest_price`.
 * Derived from the label rather than looked up, so a mechanism not seen yet
 * still arrives as a code rather than as nothing.
 */
export const evaluationMethodOf = (label) => {
  const code = String(label ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return code || null;
};

/** "45221142-ընդհանուր շինարարական աշխատանքներ" (one per line) -> codes and labels. */
const parseCpv = ($, $dd) =>
  ($dd.html() ?? '')
    .split(/<br\s*\/?>/i)
    .map((part) => cheerio.load(`<i>${part}</i>`)('i').text().replace(/\s+/g, ' ').trim())
    .map((line) => line.match(/^(\d{8})(?:-\d(?=\s*-))?\s*-?\s*(.*)$/))
    .filter(Boolean)
    .map(([, code, label]) => ({ code, label: label || null }));

/** "[2] ռետինափողրակներ /…/" -> lot 2. */
const parseLotName = (value) => {
  const match = String(value).match(/^\[(\d+)\]\s*(.*)$/);
  return match ? { lotNumber: Number(match[1]), name: match[2] || null } : null;
};

const LANGUAGE = { HY: 'hy', EN: 'en', RU: 'ru' };

const parseDocuments = ($) => {
  const documents = [];
  $('table#T02 tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 5) return;
    const $file = $(cells[2]).find('a').first();
    const documentId = ($file.attr('onclick') ?? '').match(/downloadDocForAnonymous\((\d+)\)/)?.[1] ?? null;
    const text = (i) => $(cells[i]).text().replace(/\s+/g, ' ').trim();
    documents.push({
      documentId,
      addendum: text(0) === 'N/A' ? null : text(0) || null,
      title: text(1) || null,
      fileName: $file.text().replace(/\s+/g, ' ').trim() || null,
      language: LANGUAGE[text(4).toUpperCase()] ?? null,
    });
  });
  const total = Number($('.Pagination .Results strong').first().text().trim());
  return { documents, documentsTotal: Number.isFinite(total) && total > 0 ? total : documents.length };
};

/**
 * @returns the page's fields; `labelsSeen` is the layout-health signal (0 on
 *   a CfT page means the markup changed), and `documentsTotal` above
 *   `documents.length` means the list paginated past what one page shows.
 */
export const parseCft = (html) => {
  const $ = cheerio.load(html);

  const fields = new Map();
  $('#MoreCFTInfo dl.Grid > dt').each((_, dt) => {
    const label = $(dt).text().replace(/\s+/g, ' ').replace(/\s*:\s*$/, '').trim();
    const $dd = $(dt).nextAll('dd').first();
    if (label && !fields.has(label)) fields.set(label, $dd);
  });

  const text = (label) => {
    const $dd = fields.get(label);
    const value = $dd ? $dd.text().replace(/\s+/g, ' ').trim() : '';
    return value || null;
  };

  const lots = [...fields.keys()]
    .filter((label) => /^Lot Name\(\d+\)$/.test(label))
    .map((label) => parseLotName(text(label)))
    .filter(Boolean);

  const clarifications = allDates(text('Request for clarifications (from-to)'));
  const procedureLabel = text('Procedure');
  const purchaseKind = text('Procurement Type');

  return {
    labelsSeen: fields.size,
    buyerName: text('Name of Contracting Authority'),
    title: text('Title'),
    titleEn: text('Title (EN)'),
    titleRu: text('Title (RU)'),
    procedureCode: text('CfT Id'),
    procedureLabel,
    procedureType: procedureTypeOf(procedureLabel),
    evaluationMethod: evaluationMethodOf(text('Evaluation Mechanism')),
    goodsWorksServices: PURCHASE_KIND_LABELS[String(purchaseKind).toLowerCase()] ?? null,
    cpv: fields.has('CPV Codes') ? parseCpv($, fields.get('CPV Codes')) : [],
    estimatedValue: toAmount(text('Estimated value (AMD)')),
    deadlineAt: toDate(text('Time-limit for receipt of tenders or requests to participate')),
    qnaDeadlineAt: clarifications[1] ?? null,
    publishedAt: toDate(text('Date of Publication/Invitation')),
    lotCount: Number(text('Number Of Lots')) || (lots.length || 0),
    lots,
    ...parseDocuments($),
  };
};

export default { canonicalPage, isCftPage, parseCft, procedureTypeOf, evaluationMethodOf };
