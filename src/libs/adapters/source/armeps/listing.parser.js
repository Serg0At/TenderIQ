import * as cheerio from 'cheerio';

/**
 * Pure HTML -> data. No network, no database, no config.
 *
 * This is the file that breaks when gnumner is redesigned, so it is kept pure:
 * it can be unit-tested against a saved fixture, and a layout change is a
 * one-file fix plus a replay of stored raw payloads — never a re-crawl.
 *
 * Markup it targets (verified against the live board):
 *
 *   <div class="tender">
 *     <div class="tender_title"><p class="cont_text">
 *       <a href="https://armeps.am/epps/cft/listContractDocuments.do?resourceId=12347668">TITLE</a>
 *     </p></div>
 *     <div><p class="tender_time">
 *       (Հրապարակված է 2026-07-31 16:08:00-ից մինչեւ 2026-08-31 10:00:00 ժամը ներառյալ)
 *     </p></div>
 *   </div>
 */

/**
 * Armenia is UTC+4 all year — no daylight saving. Without an explicit offset,
 * `new Date('2026-07-31 16:08:00')` is interpreted in the *server's* timezone,
 * silently shifting every published/deadline time on any host not set to Yerevan.
 */
const AM_UTC_OFFSET = '+04:00';

const toDate = (value) => {
  const date = new Date(`${value.replace(' ', 'T')}${AM_UTC_OFFSET}`);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Both timestamps are pulled positionally rather than by matching the Armenian
 * wording around them ("Հրապարակված է ... մինչեւ ..."), so the site rephrasing
 * its sentence does not break date extraction. First = published, second =
 * deadline.
 */
const TIMESTAMP = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g;

const parseWindow = (text) => {
  const found = String(text).match(TIMESTAMP) || [];
  return {
    publishedAt: found[0] ? toDate(found[0]) : null,
    deadlineAt: found[1] ? toDate(found[1]) : null,
  };
};

export const parseListing = (html) => {
  const $ = cheerio.load(html);
  const seen = new Set();
  const rows = [];

  const blocks = $('div.tender');

  // The board mixes two kinds of notice:
  //   1. ARMEPS e-procurement  -> armeps.am/...?resourceId=N   (handled here)
  //   2. Direct-attachment     -> gnumner.../original/x.zip    (skipped in v1)
  // The second kind is real procurement (Gazprom Armenia open-offer requests,
  // ministry quotation requests) but carries no stable id and hides its detail
  // inside a ZIP. Counting them separately from "no blocks at all" is what lets
  // the caller distinguish "different notice type" from "layout broke".
  let skippedNoResourceId = 0;
  let skippedDuplicate = 0;

  blocks.each((_, element) => {
    const $row = $(element);
    const link = $row.find('.tender_title .cont_text a').first();
    const url = link.attr('href');
    if (!url) {
      skippedNoResourceId += 1;
      return;
    }

    let sourceId;
    try {
      sourceId = new URL(url).searchParams.get('resourceId');
    } catch {
      skippedNoResourceId += 1; // malformed href — skip the row, not the page
      return;
    }
    if (!sourceId) {
      skippedNoResourceId += 1;
      return;
    }

    // The board renders each notice more than once (page 1: 10 blocks, 6 unique
    // ids). Without this the same tender is hashed, stored and enqueued twice.
    if (seen.has(sourceId)) {
      skippedDuplicate += 1;
      return;
    }
    seen.add(sourceId);

    rows.push({
      sourceId,
      url,
      title: link.text().trim().replace(/\s+/g, ' '),
      ...parseWindow($row.find('.tender_time').text()),
    });
  });

  // Highest numbered link in the pager; page 1 carries no numeric suffix.
  const pageNumbers = $('div.pagination a.numbers_url')
    .map((_, a) => Number.parseInt($(a).text().trim(), 10))
    .get()
    .filter(Number.isFinite);

  return {
    rows,
    // blocksSeen is the layout-health signal: 0 blocks on a 200 means the markup
    // changed. rows.length being 0 while blocksSeen > 0 just means this page held
    // no ARMEPS-linked notices — normal on the older pages, not an incident.
    blocksSeen: blocks.length,
    skipped: { noResourceId: skippedNoResourceId, duplicate: skippedDuplicate },
    pagination: { lastPage: pageNumbers.length ? Math.max(...pageNumbers) : 1 },
  };
};

export default { parseListing };
