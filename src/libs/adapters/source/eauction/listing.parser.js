import * as cheerio from 'cheerio';

/**
 * Pure HTML -> data. No network, no database, no config.
 *
 * Verified against the live page at https://eauction.armeps.am/hy/public/tender/
 * on 2026-08-13. That page is a <table>, one <tr> per tender, columns:
 *   Հ/հ (id) | Ծածկագիր (code) | Վերնագիր (title) | Չափաբաժինների քանակ (lots)
 *   | Կարգավիճակ (status) | Վերջնաժամկետ (deadline) | detail link
 *
 * The detail link is the one reliable place to get a stable id: it points to
 * .../tender_details/tid/<N>/ — that <N> is `sourceId`. Do not use the visible
 * "Հ/հ" column as the id; confirm it matches tid before trusting it, columns
 * on gov sites get reordered without notice.
 *
 * The table carries no publish date — only a deadline. `publishedAt` is a
 * detail-page-only field, so nothing here may depend on it. The sweep's
 * pagination depth is driven by the tid high-water mark instead (see
 * workers/listingChain.js); tids are assigned in ascending order and the board is
 * sorted newest-first, which makes them a reliable "have I seen this far
 * back already?" signal.
 */

const AM_UTC_OFFSET = '+04:00';

const toDate = (value) => {
  const date = new Date(`${value.replace(' ', 'T')}${AM_UTC_OFFSET}`);
  return Number.isNaN(date.getTime()) ? null : date;
};

// Table only shows a deadline, not a publish date, so parseWindow no longer
// looks for two timestamps here.
const parseDeadline = (text) => {
  const found = String(text).match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  return found ? toDate(found[0]) : null;
};

const TID_RE = /\/tid\/(\d+)/;

export const parseListing = (html) => {
  const $ = cheerio.load(html);
  const seen = new Set();
  const rows = [];

  // Table rows that actually represent a tender have a detail link with
  // /tid/<N>/ in them. Header/filter rows won't match, so we select on the
  // link rather than assuming a fixed table/tbody structure — this class of
  // gov site inserts/removes wrapper markup often but the tid link is stable.
  const detailLinks = $('a[href*="/tid/"]');

  let skippedNoTid = 0;
  let skippedDuplicate = 0;

  detailLinks.each((_, a) => {
    const $a = $(a);
    const href = $a.attr('href');
    const match = href && href.match(TID_RE);
    if (!match) {
      skippedNoTid += 1;
      return;
    }
    const sourceId = match[1];

    if (seen.has(sourceId)) {
      skippedDuplicate += 1;
      return;
    }
    seen.add(sourceId);

    const $row = $a.closest('tr');
    const cells = $row.find('td');

    // Column order per the verified markup above. If cells.length doesn't
    // match, the table shape changed — fall back to null fields rather than
    // guessing, so a layout change shows up as missing data, not wrong data.
    const code = cells.eq(1).text().trim();
    const title = cells.eq(2).text().trim().replace(/\s+/g, ' ');
    const status = cells.eq(4).text().trim();
    const deadlineAt = parseDeadline(cells.eq(5).text());

    let url;
    try {
      url = new URL(href, 'https://eauction.armeps.am').toString();
    } catch {
      url = href;
    }

    // The table lists every tender regardless of status (Հրապարակված,
    // Շնորհում, Ավարտված, Չկայացած) and ALL of them are wanted.
    //
    // An earlier version dropped rows whose deadline had passed. That threw
    // away exactly the rows that matter: a finished tender's detail page is
    // where suppliers, bid prices and the estimated price live — the entire
    // benchmark corpus. It also put Date.now() inside a parser that must stay
    // pure, which silently broke replay-from-storage (re-normalizing a payload
    // stored last month would drop every row in it).
    //
    // Filtering by status is the worker's decision, not the parser's.
    rows.push({ sourceId, url, code, title, status, deadlineAt });
  });

  // Highest numbered link in the pager; page 1 carries no numeric suffix.
  // Only a backfill's page range reads this. A live chain asks hasNextPage.
  const pageNumbers = $('a')
    .map((_, a) => {
      const m = $(a).attr('href')?.match(/\/start\/(\d+)/);
      return m ? Number.parseInt(m[1], 10) : null;
    })
    .get()
    .filter((n) => Number.isFinite(n));

  return {
    rows,
    // blocksSeen is the layout-health signal: 0 links on a 200 means the
    // markup changed. rows.length being 0 while blocksSeen > 0 would mean
    // something else (e.g. all duplicates) — worth alerting on too.
    blocksSeen: detailLinks.length,
    skipped: { noTid: skippedNoTid, duplicate: skippedDuplicate },
    pagination: { lastPage: pageNumbers.length ? Math.max(...pageNumbers) : 1 },
    // The pager's "→" arrow (a.pg_b, beside a "←" of the same class). Its
    // presence is the answer, not its href, which on page 1 is malformed
    // (…/tender/hy/public/start/2). Checked live 2026-10-19: the arrow
    // overstates the tail — pages 1016 and 1017 of 1017 are empty and still
    // carry it — which only a chain walking the whole archive would reach.
    hasNextPage: $('a.pg_b').filter((_, a) => $(a).text().trim() === '→').length > 0,
  };
};

export default { parseListing };
