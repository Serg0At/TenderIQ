import * as cheerio from 'cheerio';

/**
 * Pure HTML -> data. No network, no database, no clock, and no config of its
 * own: the base URL and the hosts it classifies against are passed in, built
 * from the sources config by the client, as eauction's `parseDetail(html,
 * { baseUrl })` already does. So `SOURCE_GNUMNER_BASE` really changes how
 * relative links resolve and which host counts as gnumner's own.
 *
 * Verified against the live announcement listings on 2026-10-19:
 *   https://gnumner.minfin.am/hy/page/gnanshman_harcman_haytararutyun_ev_hraver/  (quotation)
 *   https://gnumner.minfin.am/hy/page/bac_mrcuyti_haytararutyun_ev_hraver/        (open tender)
 * Every announcement listing has the same shape, one block per notice:
 *
 *   <div class="tender">
 *     <div class="tender_title"><p class="cont_text"><a href="<target>">title</a></p></div>
 *     <img class="doc_img" …/>
 *     <div><p class="tender_time">(Հրապարակված է 2026-10-19 20:30:16-ից մինչեւ
 *       2026-10-26 11:10:00 ժամը ներառյալ)</p></div>
 *   </div>
 *
 * The amendment listing («Հրավերում կատարված փոփոխություններ», ticket 07,
 * verified 2026-10-21) is the same block without the `tender_time` class on
 * its date paragraph, and an uploaded notice there is open-ended:
 * «(Հրապարակված է 2026-10-20 10:28:43-ից անժամկետ)» — published, and no close.
 *
 * There is no per-notice id page. What identifies a notice is where its link
 * points, so that is what `classify` reads:
 *   - <armeps host> …/listContractDocuments.do?resourceId=N  → an ARMEPS tender
 *   - <eauction host> …/tender_details/tmid/<uuid>          → an e-auction (counted only)
 *   - /website/images/… on <gnumner host>                   → an uploaded file: paper
 *
 * The listing is a multi-year archive sorted newest-first by publish
 * datetime, which is what the sweep's depth control rests on (see
 * workers/gnumner.js). The pager's last-page number is deliberately not read:
 * the sweep never trusts it, and a field nobody may use is a field someone
 * eventually will.
 */

const AM_UTC_OFFSET = '+04:00';
const DATETIME_RE = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2})?)/g;

const toDate = (day, time) => {
  const date = new Date(`${day}T${time.length === 5 ? `${time}:00` : time}${AM_UTC_OFFSET}`);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * "(Հրապարակված է <from>-ից մինչեւ <until> ժամը ներառյալ)" — published from,
 * open until. The second datetime is the announced close; it is carried, not
 * trusted as the deadline, because the paper invitation states its own.
 */
const parseWindow = (text) => {
  const found = [...String(text).matchAll(DATETIME_RE)];
  return {
    publishedAt: found[0] ? toDate(found[0][1], found[0][2]) : null,
    closesAt: found[1] ? toDate(found[1][1], found[1][2]) : null,
  };
};

/**
 * The procedure code as it appears in the title, raw — normalising it is the
 * resolution module's job (`normalizeCode`), so that there is one definition.
 *
 * Every Armenian procurement code carries the method marker `ՁԲ` inside one
 * dash-joined segment and ends in a numbered suffix: ՊՄԱԹ-ԳՀԱՇՁԲ-26/42,
 * ԿԲՀ-ՍԱՊ–ԳՀԱՊՁԲ-26/19 (en dash), ՀՀ ՆԳՆ ԳՀԾՁԲ-Ա-68/2026 and ՀՀ ՊՆ-ԲՄԱՊՁԲ-27-7/5
 * (a short space-separated buyer prefix). The space-separated prefix is
 * capped at two short words, or an all-caps title would be swallowed whole,
 * and a match may only start at a word boundary — in an all-caps title it
 * otherwise begins inside the preceding word (`ՐՎԱԾ ԿՄՀՔ-…`). A title with no
 * code yields null, never a guess: a fair share of them name none, and the
 * invitation carries it.
 */
const DASH = '\\s?[-‐‑‒–—―]\\s?';
const CODE_RE = new RegExp(
  `(?<![Ա-Ֆա-և])(?:[Ա-Ֆ]{1,4} ){0,2}(?:[Ա-Ֆ0-9]+${DASH})*[Ա-Ֆ]*ՁԲ[Ա-Ֆ]*(?:${DASH}[Ա-Ֆ0-9/.]+)+`,
  'gu'
);

export const extractProcedureCode = (title) => {
  for (const found of String(title).matchAll(CODE_RE)) {
    // A code ends in a number; sentence punctuation is not part of it.
    const code = found[0].replace(/[./]+$/, '').trim();
    if (/\d/.test(code.slice(code.indexOf('ՁԲ')))) return code;
  }
  return null;
};

const TMID_RE = /\/tmid\/([0-9a-f-]{36})/i;

/**
 * Where a link points decides what the notice is. Unknown targets come back
 * as `other` and are counted by the caller — a new kind of link appearing is a
 * coverage question, not something to drop quietly.
 *
 * `hosts` is `{ gnumner, armeps, eauction }`, each without `www.`.
 */
export const classify = (href, { baseUrl, hosts }) => {
  let url;
  try {
    url = new URL(href, baseUrl);
  } catch {
    return { kind: 'other', url: href };
  }

  const host = url.hostname.replace(/^www\./, '');

  if (host === hosts.armeps) {
    const resourceId = url.searchParams.get('resourceId');
    if (resourceId && /^\d+$/.test(resourceId)) {
      return { kind: 'armeps', externalId: resourceId, url: url.toString() };
    }
  }

  if (host === hosts.eauction) {
    const tmid = url.pathname.match(TMID_RE);
    if (tmid) return { kind: 'eauction', externalId: tmid[1].toLowerCase(), url: url.toString() };
  }

  if (host === hosts.gnumner && url.pathname.startsWith('/website/images/')) {
    // Uploaded files keep their original name with every non-ASCII character
    // turned into a space, so paths like "/original/   --26_42   .zip" are
    // real. The path is the identity; the URL class has already encoded it.
    const extension = url.pathname.match(/\.([a-z0-9]{1,5})$/i);
    return {
      kind: 'paper',
      externalId: url.pathname,
      url: url.toString(),
      // The file type is recorded here only to be counted. Whether a format
      // can be read is the invitation parser's decision (ticket 06), and
      // non-.docx files are counted there as `unsupported_format` on purpose —
      // .doc, .rar and scanned PDFs are meant to become supported once those
      // counts show which ones matter.
      fileType: extension ? extension[1].toLowerCase() : null,
    };
  }

  return { kind: 'other', url: url.toString() };
};

/** The «(Հրապարակված է …)» paragraph: by its class where the listing gives it one, by its words where not. */
const windowText = ($, $block) => {
  const classed = $block.find('.tender_time');
  if (classed.length) return classed.text();
  return $block
    .find('p')
    .filter((_, p) => /Հրապարակված/u.test($(p).text()))
    .first()
    .text();
};

export const parseListing = (html, { baseUrl, hosts }) => {
  const $ = cheerio.load(html);
  const blocks = $('div.tender');
  const seen = new Set();
  const items = [];
  const skipped = { noLink: 0, noDate: 0, duplicate: 0 };

  blocks.each((_, block) => {
    const $block = $(block);
    const $a = $block.find('.tender_title a').first();
    const href = $a.attr('href');
    if (!href) {
      skipped.noLink += 1;
      return;
    }

    const { publishedAt, closesAt } = parseWindow(windowText($, $block));
    // Without a publish datetime the item cannot take part in depth control,
    // and a paper deadline is counted from it. Counted, never guessed.
    if (!publishedAt) {
      skipped.noDate += 1;
      return;
    }

    const target = classify(href.trim(), { baseUrl, hosts });
    // The same ARMEPS link is sometimes listed twice in a row, identically.
    const identity = `${target.kind}:${target.externalId ?? target.url}`;
    if (seen.has(identity)) {
      skipped.duplicate += 1;
      return;
    }
    seen.add(identity);

    const title = $a.text().replace(/\s+/g, ' ').trim();

    // Nothing is filtered by date here. An old notice is as much a notice as
    // a new one; what to do with it is the worker's call, and a clock in this
    // file would break replay from storage.
    items.push({
      ...target,
      title,
      procedureCode: extractProcedureCode(title),
      publishedAt,
      closesAt,
    });
  });

  return {
    items,
    // Layout-health signal: zero blocks on a 200 means the markup changed.
    blocksSeen: blocks.length,
    skipped,
    // Only whether a next page exists — see the header on the page total.
    hasNextPage: $('.pagination a.e').length > 0,
  };
};

export default { parseListing, classify, extractProcedureCode };
