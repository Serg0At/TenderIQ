import { extractProcedureCode } from './listing.parser.js';
import { cellText, wordDocuments } from './word.js';

/**
 * Pure: the bytes of one upload on gnumner's «Կնքված պայմանագրի մասին
 * հայտարարություն» listing in, what the notice says out. No network, no
 * database, no clock, so a replay from storage reads what the first run read.
 *
 * The notice is the Ministry of Finance template of order 323-Ա (2021-06-29,
 * Annex 1): the only public record of a paper tender's bidders and prices.
 * Verified on 2026-10-21 against the two research samples and 31 live
 * uploads (34 Word documents). Most put the whole notice in one table, in
 * this order:
 *
 *   «X» ՊՈԱԿ-ը … «ԽՄՄ-ԳՀԾՁԲ-26/09» ծածկագրով գնման ընթացակարգի արդյունքում կնքված պայմանագրի մասին …
 *   Գնման առարկայի …               lot | name | unit | qty ×2 | budget: available, total | spec ×2
 *   Հրավեր ուղարկելու կամ հրապարակելու ամսաթիվը | 11.09.2026թ.
 *   Հ/Հ | Մասնակցի անվանումը | … ներկայացված գինը
 *         Գինն առանց ԱԱՀ | ԱԱՀ | Ընդհանուր          net | VAT | total
 *   Չափաբաժին 1
 *   1 | «ԱՅԱՅ ՍԵՔ» ՍՊԸ | 3323470 | 664694 | 3988164
 *   Տվյալներ մերժված հայտերի մասին    lot | name | four criteria, բավարար or not
 *   Չափա-բաժնի համարը | Ընտրված մասնակիցը | Պայմանագրի …
 *   1 | «ԱՅԱՅ ՍԵՔ» ՍՊԸ | number | signed | deadline | advance | price: available, total
 *   Ընտրված մասնակցի (մասնակիցների) անվանումը և հասցեն …
 *
 * A Russian machine translation of the whole notice often follows; nothing
 * after the winners' table is read, and its Russian headings match none of
 * the Armenian ones. A bilingual notice glues the translation onto each cell
 * («ԲԵԼՄԵՏ ՍՊԸБЕЛМЕТ ООО»), so a cell is read up to its first Cyrillic letter.
 *
 * What varies, all seen: the lot as a «Չափաբաժին N» row (with or without N,
 * alone or carrying the first bid), or as the first cell of a price table
 * whose header says «Չափաբաժին» rather than «Հ/Հ»; VAT written as 0, - or
 * nothing — a non-VAT payer, whose net is its total; amounts as 3323470,
 * 3 323 470, 6,480,000, 2 505 766.43 and 289667,5/…in words…/; dates as
 * 11.09.2026թ., 2026-09-11, 24․09․2026թ․ and 23. 09 2026թ; one contract row
 * for lots «1.2»; a bidder listed twice in one lot, before and after
 * negotiation; a lot range «1-47» priced as one, which is not read.
 */

const CYRILLIC = /[Ѐ-ӿ]/u;
const ARMENIAN = /[Ա-և]/u;

/** A cell with its Russian translation glued on: the Armenian part. */
const armenianPart = (text) => {
  const at = text.search(CYRILLIC);
  return at > 0 && ARMENIAN.test(text.slice(0, at)) ? text.slice(0, at).trim() : text.trim();
};

/** An empty cell, or one a buyer filled with a dash or an ellipsis to say so. */
const isBlank = (text) => /^[\s\-–—…․.]*$/u.test(text);

/**
 * An AMD amount; null for a cell with no number in it (blank, a dash, or
 * words — a VAT cell reading "exempt" is no VAT); undefined for digits that
 * do not read as one amount, and the row is then not read rather than read
 * wrong. A comma is a thousands separator only in groups of three
 * (6,480,000); 289667,5 and 347601,00 are decimals. Anything after a slash
 * is the amount in words, and a unit after the digits («դրամ») is dropped.
 */
export const readAmount = (text) => {
  const head = armenianPart(String(text ?? '')).split('/')[0].replace(/\s/g, '').replace(/[^\d.,]+$/u, '');
  if (isBlank(head)) return null;
  let digits = head;
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(digits)) digits = digits.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(digits)) digits = digits.replace(',', '.');
  return /^\d+(?:\.\d+)?$/.test(digits) ? Number(digits) : undefined;
};

const DMY_RE = /(\d{1,2})\s*[.․,/]\s*(\d{1,2})\s*[.․,/]?\s*(\d{4})/u;
const ISO_RE = /(\d{4})-(\d{2})-(\d{2})/;

/** A calendar date as `YYYY-MM-DD`, or null — never a date the calendar does not have. */
export const readDate = (text) => {
  const source = armenianPart(String(text ?? ''));
  const iso = source.match(ISO_RE);
  const dmy = iso ? null : source.match(DMY_RE);
  if (!iso && !dmy) return null;
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]].map(Number) : [dmy[3], dmy[2], dmy[1]].map(Number);
  const real = new Date(Date.UTC(y, m - 1, d));
  if (real.getUTCFullYear() !== y || real.getUTCMonth() !== m - 1 || real.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/**
 * A bidder's name as a matching key inside one notice, and the identity a
 * paper supplier is keyed on: quote marks of every kind (and the <<>> of a
 * keyboard without «) are typesetting, so they become spaces; case and runs
 * of whitespace do not make two companies. Nothing more — «Ա/Ձ Նարեկ
 * Կոստանյան» and «Նարեկ Կոստանյան ԱՁ» stay two keys, because a looser rule is
 * a guess about who is who.
 */
export const bidderKey = (name) =>
  String(name ?? '')
    .replace(/[«»"'“”„‘’<>]/g, ' ')
    .replace(/[.,;:։]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const SATISFACTORY_RE = /^բավարար\.?$/iu;
const LOT_LABEL_RE = /^Չափաբաժին\s*(.*)$/u;

/** «1», «1.2», «1, 2», «1-2» → lot numbers; anything else → null. */
const lotList = (text) => {
  const cell = armenianPart(text).replace(/\s+/g, '');
  if (/^\d+$/.test(cell)) return [Number(cell)];
  const range = cell.match(/^(\d+)[-–](\d+)$/);
  if (range) {
    const [lo, hi] = [Number(range[1]), Number(range[2])];
    return hi > lo && hi - lo < 100 ? Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) : null;
  }
  if (/^\d+(?:[.,;]\d+)+$/.test(cell)) return cell.split(/[.,;]/).map(Number);
  return null;
};

/**
 * The procedure code, from the sentence that introduces the notice:
 * «… «ԽՄՄ-ԳՀԾՁԲ-26/09» ծածկագրով գնման ընթացակարգի արդյունքում կնքված
 * պայմանագրի …». Through the listing parser's rule, so there is one
 * definition of a code; null when the sentence names none (seen: «…
 * կազմակերպված ծածկագրով …», the code left out).
 */
const readCode = (paragraphs) => {
  const intro = paragraphs.find((text) => /ծածկագր/u.test(text) && /պայմանագր/u.test(text));
  return intro ? extractProcedureCode(intro.replace(/[«»"“”<>]/g, ' ')) : null;
};

/**
 * The buyer, from the sentence that presents the notice: «X-ը, որը գտնվում է
 * … հասցեում, ստորև ներկայացնում է …», or without the address, «X-ը ստորև
 * ներկայացնում է …». As the invitation parser reads it, quotes and all, with
 * only the definite article the sentence adds removed, so a paper tender's
 * buyer and its contract notice's are one party.
 *
 * A name starting with a lowercase letter is a template filled in wrong
 * (seen: «կարիքների համար , Ալավերդի համայնքի …» in the paragraph above the
 * real one), so the first sentence that does not is taken, and none is null.
 */
const readBuyer = (paragraphs) => {
  for (const text of paragraphs) {
    const found = text.match(/^(.+?)\s*,?\s*(?:որ(?:ը|ն)\s+գտնվում|ստորև\s+ներկայացնում)/u);
    if (!found) continue;
    const name = found[1]
      .replace(/^(?:Պատվիրատու(?:ն)?\s*[`՝’':]*\s*)+/u, '')
      .replace(/\s*[-–]\s*(?:ը|ն)$|ը$/u, '')
      .trim();
    if (name && name.length <= 200 && !/^[ա-և]/u.test(name)) return name;
  }
  return null;
};

/**
 * The procedure the notice says was applied, from its «Կիրառված գնման
 * ընթացակարգը և դրա ընտրության հիմնավորումը» row: named outright (Գնանշման
 * հարցում, մեկ անձից), or by the article of the procurement law it cites —
 * 22 for a quotation, 23 for single source. Seen on the stored notices
 * (ticket 31): every ՄԱ code cites article 23, every ԳՀ code 22 (with 15 or
 * 18 beside it in two). An empty row, another article, or both is null.
 */
const readProcedure = (rows) => {
  const row = rows.find((cells) => /^Կիրառված գնման ընթացակարգ/u.test(armenianPart(cells[0] ?? '')));
  if (!row) return null;
  const text = row.slice(1).map(armenianPart).join(' ');
  if (/մեկ անձից/iu.test(text)) return 'single_source';
  if (/գնանշման հարցում/iu.test(text)) return 'quotation';
  const articles = new Set([...text.matchAll(/(\d+)\s*-?\s*(?:րդ|ին)?\s*հոդված/gu)].map((m) => Number(m[1])));
  if (articles.has(23) && !articles.has(22)) return 'single_source';
  if (articles.has(22) && !articles.has(23)) return 'quotation';
  return null;
};

/**
 * Walk the notice's rows in order, as one state machine: which section a row
 * is in is told by the headings before it, never by its position, since the
 * number of rows in each section varies.
 */
const readRows = (rows) => {
  const out = {
    invitationDate: null,
    subject: [],
    bids: [],
    rejected: [],
    contracts: [],
    unreadRows: 0,
    priceTableFound: false,
    lotInFirstCell: false,
    lotLabels: 0,
    numberedLabels: 0,
  };
  let section = null;
  let nameAt = 1;
  let winnerAt = 1;
  let criteria = [];
  let labelLot; // the last «Չափաբաժին» row's lot: undefined before one, NaN for a label that is not one lot
  let lastContractLots = null;

  for (const raw of rows) {
    const cells = raw.map(armenianPart);
    const row = cells.join(' | ');
    if (cells.every(isBlank)) continue;

    // ── Headings ──
    // The price table first: one layout heads it «… | Գնման առարկայի | Մասնակցի անվանումը | …».
    if (cells.some((c) => /^Մասնակցի անվանումը/u.test(c)) && /գինը/u.test(row)) {
      // A second price table is the Russian copy of a notice written twice.
      if (out.priceTableFound) break;
      out.priceTableFound = true;
      section = 'price';
      out.lotInFirstCell = LOT_LABEL_RE.test(cells[0]);
      nameAt = cells.findIndex((c) => /^Մասնակցի անվանումը/u.test(c));
      continue;
    }
    if (/Գնման առարկայի/u.test(row) && !out.priceTableFound) {
      section = 'subject';
      continue;
    }
    if (/հրապարակելու ամսաթիվ/u.test(cells[0])) {
      out.invitationDate = readDate(cells.slice(1).join(' '));
      section = null;
      continue;
    }
    if (/մերժված հայտերի/u.test(row)) {
      section = 'rejected';
      continue;
    }
    if (/Ընտրված մասնակիցը/u.test(row) && /Պայմանագր/u.test(row)) {
      section = 'contract';
      winnerAt = cells.findIndex((c) => /Ընտրված մասնակիցը/u.test(c));
      continue;
    }
    if (/անվանումը և հասցեն/u.test(row) && section === 'contract') break;
    if (/^(?:Այլ տեղեկություններ|Ընտրված մասնակցի որոշման|Կիրառված գնման ընթացակարգ|Անգործության ժամկետ)/u.test(cells[0])) {
      section = null;
      continue;
    }

    // ── Rows ──
    if (section === 'subject') {
      // Its own column headers have no amount in the budget columns.
      if (cells.length < 7 || isBlank(cells[1])) continue;
      const budget = readAmount(cells[6]) ?? readAmount(cells[5]);
      if (budget === undefined || budget === null) continue;
      out.subject.push({ lotNumber: /^\d+$/.test(cells[0]) ? Number(cells[0]) : null, name: cells[1], budget });
    } else if (section === 'price') {
      if (/առանց ԱԱՀ/u.test(row)) continue;
      const label = cells[0].match(LOT_LABEL_RE);
      if (label) {
        const named = label[1].trim();
        out.lotLabels += 1;
        if (named) out.numberedLabels += 1;
        labelLot = named ? (/^\d+$/.test(named) ? Number(named) : NaN) : undefined;
      }
      if (cells.length < nameAt + 4) continue; // a lot label, perhaps with the lot's name
      const name = cells[nameAt];
      if (isBlank(name) || /^\d+\.?$/.test(name)) continue;
      const [net, vat, gross] = cells.slice(-3).map(readAmount);
      if ([net, vat, gross].includes(undefined) || (net === null && gross === null) || Number.isNaN(labelLot)) {
        out.unreadRows += 1;
        continue;
      }
      const first = label ? null : cells[0].replace(/\.$/, '');
      out.bids.push({
        labelLot,
        labelIndex: out.lotLabels,
        firstCell: /^\d+$/.test(first ?? '') ? Number(first) : null,
        name,
        net,
        vat,
        gross,
      });
    } else if (section === 'rejected') {
      if (/Հրավերով պահանջվող/u.test(row)) {
        criteria = cells.slice(2);
        continue;
      }
      if (cells.length < 3 || isBlank(cells[1]) || /Մասնակցի անվանումը/u.test(cells[1])) continue;
      const reasons = cells
        .slice(2)
        .map((value, i) => ({ criterion: criteria[i] ?? null, value }))
        .filter(({ value }) => !isBlank(value) && !SATISFACTORY_RE.test(value))
        .map(({ criterion, value }) => (criterion ? `${criterion}: ${value}` : value));
      // The table is headed "evaluation results (satisfactory or not)": a row
      // whose every criterion is satisfactory is an evaluation, not a rejection.
      if (!reasons.length) continue;
      out.rejected.push({ lotNumber: /^\d+$/.test(cells[0]) ? Number(cells[0]) : null, name: cells[1], reasons });
    } else if (section === 'contract') {
      if (/Պայմանագրի համարը|ՀՀ դրամ|Առկա ֆինանսական/u.test(row)) continue;
      if (cells.length < winnerAt + 3 || isBlank(cells[winnerAt])) continue;
      const lots = isBlank(cells[0]) ? lastContractLots : lotList(cells[0]);
      if (!lots) {
        out.unreadRows += 1;
        continue;
      }
      lastContractLots = lots;
      // After the winner: a bilingual notice's Russian name, then the contract
      // number, the date it was signed, the deadline, the advance, the price.
      const after = cells.slice(winnerAt + 1).filter((c) => !CYRILLIC.test(c) || ARMENIAN.test(c));
      const price = readAmount(cells[cells.length - 1]);
      out.contracts.push({
        lotNumbers: lots,
        winner: cells[winnerAt],
        number: isBlank(after[0] ?? '') ? null : after[0],
        signedOn: readDate(after[1] ?? ''),
        price: price === undefined ? null : price,
      });
    }
  }
  return out;
};

/**
 * One bidder's offer, VAT filled where the notice leaves it: a blank VAT cell
 * is a non-VAT payer, whose net is its total (decided in the ticket, and what
 * every such row in the samples shows).
 */
const offerOf = ({ net, vat, gross }) => {
  const tax = vat ?? 0;
  return {
    net: net ?? gross - tax,
    vat: vat ?? (net !== null && gross !== null ? gross - net : 0),
    gross: gross ?? net + tax,
  };
};

/** The one lot a notice is about, when its subject table lists one or none; null when it lists several. */
const singleLotOf = (read) => (read.subject.length <= 1 ? (read.subject[0]?.lotNumber ?? 1) : null);

/**
 * Which lot each price row is, decided once for the whole table, because a
 * row alone cannot say: «1» in the first cell is a lot under a «Չափաբաժին»
 * header and a row number under «Հ/Հ». In order:
 *
 *   - the header says «Չափաբաժին»: the first cell, a blank one continuing the
 *     lot above it;
 *   - «Չափաբաժին N» rows: the last one above;
 *   - several «Չափաբաժին» rows with no number: their position;
 *   - one lot in the subject table, or none listed: that lot, else 1.
 *
 * Anything else is not read: a row under no lot is a price nobody can place.
 * The case that decided it (ff878535, 36 books): one bidder, 36 rows numbered
 * 1–36 under «Հ/Հ», and 36 lots in the subject table — the row number looks
 * exactly like the lot. It is not: 5 rows exceed their lot's budget, and the
 * contract for lots 1–36 is the budgets' sum (42 020), not the rows' (45 700).
 */
const lotsOfRows = (read) => {
  let previous = null;
  if (read.lotInFirstCell) {
    return read.bids.map((bid) => (previous = bid.firstCell ?? previous));
  }
  if (read.numberedLabels > 0) return read.bids.map((bid) => bid.labelLot ?? null);
  if (read.lotLabels > 1) return read.bids.map((bid) => bid.labelIndex || null);
  const single = singleLotOf(read);
  return read.bids.map(() => single);
};

/**
 * The rows read → lots: each bidder once per lot, rejections and the winner
 * attached by name within the notice.
 *
 * A bidder listed twice in a lot is one bid at its lowest price: the template
 * lists prices "including after negotiation", and a negotiated price only
 * goes down. The winner is the contract row's name among the lot's bids, or,
 * when the names differ («ԱՐՄԱՎ» ՍՊԸ and «ԱՐՄԱՎ» ՍՊԸ և «Հազարաշեն» ԱԿ
 * կոնսորցիում), the lot's one bid that was not rejected; otherwise the lot
 * has a contract and no named winning bid, which is said, not guessed.
 */
const assemble = (read) => {
  const singleLot = singleLotOf(read);
  const lotOf = (lotNumber) => lotNumber ?? singleLot;

  const lots = new Map();
  const lotFor = (lotNumber) => {
    if (!lots.has(lotNumber)) lots.set(lotNumber, { lotNumber, budget: null, bids: new Map(), contract: null });
    return lots.get(lotNumber);
  };
  let unreadRows = read.unreadRows;

  const rowLots = lotsOfRows(read);
  for (const [i, bid] of read.bids.entries()) {
    const lotNumber = rowLots[i];
    if (lotNumber === null) {
      unreadRows += 1;
      continue;
    }
    const key = bidderKey(bid.name);
    const offer = offerOf(bid);
    const bids = lotFor(lotNumber).bids;
    const seen = bids.get(key);
    if (!seen || offer.net < seen.net) bids.set(key, { name: bid.name, key, ...offer, rejected: false, reasons: [] });
  }

  read.subject.forEach((row, i) => {
    const lot = lots.get(row.lotNumber ?? i + 1);
    if (lot) lot.budget = row.budget;
  });

  for (const rejection of read.rejected) {
    const key = bidderKey(rejection.name);
    const lotNumber = lotOf(rejection.lotNumber);
    const where = lotNumber === null ? [...lots.values()] : [lotFor(lotNumber)];
    let found = false;
    for (const lot of where) {
      const bid = lot.bids.get(key);
      if (bid) {
        Object.assign(bid, { rejected: true, reasons: rejection.reasons });
        found = true;
      }
    }
    // Rejected before its price was read: still a bidder, with no price.
    if (!found && lotNumber !== null) {
      lotFor(lotNumber).bids.set(key, { name: rejection.name, key, net: null, vat: null, gross: null, rejected: true, reasons: rejection.reasons });
    }
  }

  for (const contract of read.contracts) {
    for (const lotNumber of contract.lotNumbers) {
      const lot = lots.get(lotNumber);
      if (!lot) continue;
      const standing = [...lot.bids.values()].filter((b) => !b.rejected && b.net !== null);
      // The bidder the contract names won, whatever another table says of it;
      // only a name the bids do not carry falls back to the lot's one standing bid.
      const named = lot.bids.get(bidderKey(contract.winner));
      const winner = named ?? (standing.length === 1 ? standing[0] : null);
      lot.contract = {
        winner: contract.winner,
        winnerKey: winner?.key ?? null,
        number: contract.number,
        signedOn: contract.signedOn,
        // One price for several lots is not any one lot's price.
        price: contract.lotNumbers.length === 1 ? contract.price : null,
      };
    }
  }

  return {
    lots: [...lots.values()]
      .sort((a, b) => a.lotNumber - b.lotNumber)
      .map((lot) => ({ ...lot, bids: [...lot.bids.values()] })),
    unreadRows,
  };
};

const readNotice = ($, entryName) => {
  const paragraphs = $('w\\:p')
    .map((_, p) => cellText($, p))
    .get()
    .filter(Boolean);
  const rows = $('w\\:tr')
    .filter((_, tr) => $(tr).parents('w\\:tbl').length === 1)
    .map((_, tr) => [$(tr).children('w\\:tc').map((__, tc) => cellText($, tc)).get()])
    .get();
  const read = readRows(rows);
  const { lots, unreadRows } = assemble(read);
  return {
    entryName,
    procedureCode: readCode(paragraphs),
    buyerName: readBuyer(paragraphs),
    procedure: readProcedure(rows),
    invitationDate: read.invitationDate,
    priceTableFound: read.priceTableFound,
    lots,
    unreadRows,
    bidCount: lots.reduce((n, lot) => n + lot.bids.length, 0),
  };
};

/**
 * One upload → what the contract notice says.
 *
 * @returns {{ format: string, readable: boolean, notice: object|null }}
 *   `notice` is `{ entryName, procedureCode, buyerName, procedure,
 *   invitationDate, priceTableFound, lots, unreadRows, bidCount }` —
 *   `entryName` the .docx inside a .zip, null for a .docx; `procedure` the
 *   type the notice states (`quotation`, `single_source`) or null — each
 *   lot `{ lotNumber, budget, bids: [{ name, key, net, vat, gross, rejected,
 *   reasons }], contract: { winner, winnerKey, number, signedOn, price } | null }`.
 */
export const parseContractNotice = (bytes) => {
  const { format, documents } = wordDocuments(bytes, readNotice);
  const [notice = null] = documents
    .filter((doc) => doc.priceTableFound && doc.bidCount > 0)
    .sort((a, b) => b.bidCount - a.bidCount);

  // ── The format check ──────────────────────────────────────────────────────
  // Sergey: as for invitations (invitation.parser.js), only .docx, and .docx
  // inside a .zip, are read today — and only when the 323-Ա price table is
  // found in it with at least one bid. Everything else comes back
  // `readable: false`: old .doc, .rar, .7z, .pdf (several buyers upload the
  // signed notice as a scan), and a Word file that is not the template. The
  // contract notice's content must be read — the prices are the point — so
  // unlike an amendment notice it cannot attach unread. paper.js records each
  // as an `unsupported_format` unmatched result and writes no result.
  //
  // That is deliberate, not a gap nobody noticed. They are counted so that
  // the numbers, not a guess, decide which converter is worth adding
  // (LibreOffice for .doc, unrar and 7z for archives, OCR for scanned PDFs).
  // They are meant to become supported. The raw file is stored either way,
  // and a notice is re-read from storage (paper.js#recordContract), so a
  // converter added later replays them without re-crawling gnumner. On the
  // first ten listing pages (2026-10-21, 60 notices): 30 .docx, 13 .doc,
  // 8 .pdf, 7 .rar, 2 .zip. Which formats matter, per kind of notice and per
  // procedure (ticket 31): of the 18 unreadable contract notices stored on
  // 2026-10-21, 11 are single-source — prices kept out of every comparison
  // anyway, and never a missed tender — so read the competitive rows when
  // choosing a converter:
  //
  //   select case when u.external_ref like 'contract:%' then 'contract'
  //               when u.external_ref like 'amendment:%' then 'amendment'
  //               else 'invitation' end as kind,
  //          case when u.procedure_type = 'single_source' then 'single_source'
  //               when u.procedure_type is null then 'unknown'
  //               else 'competitive' end as procedure,
  //          substring(p.storage_key from '\.([a-z0-9]+)$') as ext, count(*)
  //     from unmatched_results u
  //     join source_payloads p on p.source = u.source and p.hash = u.payload_hash
  //                           and p.ref in (u.external_ref, 'detail:' || u.external_ref)
  //    where u.source = 'gnumner' and u.reason = 'unsupported_format' and u.resolved_at is null
  //    group by 1, 2, 3 order by 1, 2, 4 desc;
  //
  // A notice whose code Tendra holds only on e-auction or ARMEPS is never
  // counted here: resolution skips it before the format is asked (ticket 07's
  // lesson), since its results are that channel's source's.
  if (!notice) return { format, readable: false, notice: null };

  return { format, readable: true, notice };
};

export default { parseContractNotice, readAmount, readDate, bidderKey };
