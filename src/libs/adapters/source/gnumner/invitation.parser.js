import AdmZip from 'adm-zip';
import * as cheerio from 'cheerio';
import { extractProcedureCode } from './listing.parser.js';

/**
 * Pure: the bytes of one file uploaded to gnumner as a paper invitation in,
 * plain data out. No network, no database, no clock — the deadline is stated
 * here as "day N at HH:MM" and only turned into a datetime against the
 * notice's publish datetime by observation.js, so a replay from storage
 * reads exactly what the first run read.
 *
 * Verified on 2026-10-21 against 55 live uploads — 54 quotations (2026-04-17 →
 * 2026-10-20) and one open tender. Every readable one is the Ministry of
 * Finance announcement template:
 *
 *   ՀԱՅՏԱՐԱՐՈՒԹՅՈՒՆ / ԳՆԱՆՇՄԱՆ ՀԱՐՑՄԱՆ ՄԱՍԻՆ
 *   Ընթացակարգի ծածկագիրը` «ԿԲՀ-ՍԱՊ–ԳՀԱՊՁԲ-26/19»
 *   Պատվիրատուն` Սևան ազգային պարկ ՊՈԱԿ-ը, որը գտնվում է … հասցեում, …
 *   … կառաջարկվի կնքել «Վարչական սարքավորումների» մատակարարման պայմանագիր …
 *   … հայտերն անհրաժեշտ է ներկայացնել <address> հասցեով, փաստաթղթային ձևով
 *     մինչև սույն հայտարարության հրապարակման օրվանից հաշված 7-րդ օրվա ժամը 12:00-ն
 *
 * followed by the invitation proper, whose first table lists the lots
 * (Չափաբաժինների համարները | գնման գինը | [ծածկագիրը] | Չափաբաժնի անվանումը).
 *
 * As in eauction/invitation.parser.js, the .docx is read as XML, never with a
 * regex over the markup: revision ids (`w:rsidR`) look exactly like CPV codes.
 */

/**
 * Cap on each decompression layer, checked against the entry's declared size
 * before anything is expanded — a zip of a docx is two nested archives, and
 * the download cap alone does not bound what they expand to.
 */
const MAX_ENTRY_BYTES = 80 * 1024 * 1024;

/** The file formats a gnumner upload arrives in, told apart by their first bytes. */
const MAGIC = [
  { format: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04] }, // .docx is a zip too
  { format: 'doc', bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }, // OLE: .doc, .xls
  { format: 'rar', bytes: [0x52, 0x61, 0x72, 0x21] }, // Rar!
  { format: '7z', bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { format: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
];

/**
 * What a file is, by its first bytes: `zip` (which a .docx is too), `doc`,
 * `rar`, `7z`, `pdf`, `html` or `unknown`. The content decides, not the
 * extension: an upload's name is whatever the buyer's file was called, with
 * its non-ASCII characters blanked.
 *
 * `html` is not an upload. gnumner answers a path it does not have with its
 * own error page and a 200, so a file that turns out to be HTML is a missing
 * file, not a format to count.
 */
export const fileFormat = (bytes) => {
  const found = MAGIC.find(
    ({ bytes: magic }) => bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b)
  );
  if (found) return found.format;
  const head = bytes.subarray(0, 64).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  return head.startsWith('<') ? 'html' : 'unknown';
};

const entryData = (entry) => {
  if (entry.header.size > MAX_ENTRY_BYTES) {
    throw new Error(`${entry.entryName} declares ${entry.header.size} bytes uncompressed, over the ${MAX_ENTRY_BYTES} cap`);
  }
  return entry.getData();
};

/** A .docx's `word/document.xml`, parsed, or null when the zip is not a Word document. */
const wordDocument = (zip) => {
  const xml = zip.getEntry('word/document.xml');
  if (!xml) return null;
  return cheerio.load(entryData(xml).toString('utf8'), { xmlMode: true });
};

const runText = ($, node) =>
  $(node)
    .find('w\\:t')
    .map((_, t) => $(t).text())
    .get()
    .join('');

/** Whole-document text, a paragraph per line, whitespace collapsed inside each. */
const documentText = ($) =>
  $('w\\:p')
    .map((_, p) => runText($, p).replace(/\s+/g, ' ').trim())
    .get()
    .filter(Boolean)
    .join('\n');

const cellText = ($, cell) => runText($, cell).replace(/\s+/g, ' ').trim();

// ── Fields ───────────────────────────────────────────────────────────────────
// Each is read from one sentence of the template, and each is null when that
// sentence is not there — never filled from somewhere else in the document.

/** Quote marks buyers use around names and codes: «», "", “”, and the <<>> of a keyboard without «. */
const unquote = (text) => text.replace(/^[\s«»"“”„<>]+|[\s«»"“”„<>]+$/g, '').trim();

/** «Ընթացակարգի ծածկագիրը` «…»» — through the listing parser's code rule, so there is one definition of a code. */
const readCode = (text) => {
  const line = text.match(/ծածկագիր(?:ը|ն)?\s*[`՝’':\-–]*\s*(.+)/u);
  return line ? extractProcedureCode(line[1].replace(/[«»"“”]/g, ' ')) : null;
};

/**
 * «Պատվիրատուն` X-ը, որը գտնվում է …» — the buyer as it names itself, quotes
 * and all, since that is the name its party is keyed on. Only the definite
 * article the sentence adds is removed: a hyphenated one (ՊՈԱԿ-ը, ՊՈԱԿ -ն) or a
 * bare -ը. A bare -ն is left, because names end in ն (…կենտրոն) far more often
 * than a buyer drops the hyphen.
 */
const readBuyer = (text) => {
  // The sentence, or failing it the signature line the template closes the
  // announcement with: «Պատվիրատու՝ «Սևան» ազգային պարկ» ՊՈԱԿ».
  const found =
    text.match(/Պատվիրատու(?:ն)?\s*[`՝’':]*\s*(.+?)\s*,?\s*որ(?:ը|ն)\s+գտնվում/u) ??
    text.match(/^Պատվիրատու(?:ն)?\s*[`՝’':]*\s*(\S.{2,200})$/mu);
  if (!found) return null;
  const name = found[1]
    // A template filled in twice: «Պատվիրատուն` Պատվիրատուն` «…»».
    .replace(/^(?:Պատվիրատու(?:ն)?\s*[`՝’':]*\s*)+/u, '')
    .replace(/\s*[-–]\s*(?:ը|ն)$|ը$/u, '')
    .trim();
  return name || null;
};

/**
 * «… կնքել «Վարչական սարքավորումների» մատակարարման պայմանագիր» — what is being
 * bought, as the buyer wrote it (in the genitive the sentence puts it in), up
 * to the kind of contract: supply, services or works.
 */
const readSubject = (text) => {
  const found = text.match(
    /կնքել\s+(.+?)\s+(?:մատակարարման|ձեռքբերման|մատուցման|կատարման|իրականացման)\s+պայմանագ/u
  );
  // «X»-ի: the genitive ending a buyer hangs on a quoted name.
  return found ? unquote(found[1].replace(/\s+/g, ' ').replace(/[»"”]\s*-\s*ի$/u, '')) || null : null;
};

/**
 * The bid-submission sentence: where the sealed envelope goes and by when.
 *
 *   «… հայտերն անհրաժեշտ է ներկայացնել <address> հասցեով, փաստաթղթային ձևով
 *    մինչև սույն հայտարարության հրապարակման օրվանից հաշված 7-րդ օրվա ժամը 12:00-ն»
 *
 * The deadline is read only after «փաստաթղթային ձևով» ("in paper form"), so
 * the bid-opening sentence, which repeats the wording, is never taken for it.
 * Two forms are real:
 *
 *   - a day count: «… հրապարակման օրվանից հաշված N-րդ օրվա ժամը HH:MM». N is
 *     the buyer's own — 7, 8, 10 and 14 are all seen on quotations, 41 on an
 *     open tender — and a buyer whose 7th day is a holiday writes 8 rather than
 *     leave it there. Some write «… հրապարակման հաջորդող (or հաջորդ) օրվանից
 *     հաշված N-րդ օրվա» ("counted from the day after publication"), and their
 *     own bid-opening dates are still publication + N (8 and 41, both seen):
 *     the same arithmetic, because the count starts the day after either way.
 *   - a date: «… մինչև 27.10.2026թ օրվա ժամը 12:30», also as 26,10,2026.
 *
 * Spellings seen: «8- րդ», «“7”րդ», «ժամը 16,30», «11։00» (Armenian colon).
 */
const SUBMISSION_RE = /ներկայացնել\s+(.+?)\s*հասցե(?:ով|ում)\s*,?\s*փաստաթղթային\s+ձևով(.{0,240})/u;
const TIME = '\\s+ժամը\\s+(\\d{1,2})\\s*[:։.․,]\\s*(\\d{2})';
const DAY_COUNT_RE = new RegExp(
  `հրապարակման\\s+(?:հաջորդ(?:ող)?\\s+)?օրվանից\\s+(?:հաշված\\s+)?[«"“(]?\\s*(\\d{1,2})\\s*[»"”)]?\\s*-?\\s*(?:րդ)?\\s*օր(?:վա|ը|ն)?${TIME}`,
  'u'
);
const DATE_RE = new RegExp(`(\\d{1,2})[.,](\\d{1,2})[.,](\\d{4})\\s*թ?\\.?\\s*(?:օրվա)?${TIME}`, 'u');

const clock = (hour, minute) => (hour <= 23 && minute <= 59 ? { hour, minute } : null);

const readDeadline = (sentence) => {
  const count = sentence.match(DAY_COUNT_RE);
  if (count) {
    const day = Number(count[1]);
    const time = clock(Number(count[2]), Number(count[3]));
    return day >= 1 && day <= 60 && time ? { day, ...time } : null;
  }
  const dated = sentence.match(DATE_RE);
  if (dated) {
    const [d, m, y] = [Number(dated[1]), Number(dated[2]), Number(dated[3])];
    const time = clock(Number(dated[4]), Number(dated[5]));
    // A date the calendar does not have («31.09») is a typo, not the 1st of
    // the next month.
    const real = new Date(Date.UTC(y, m - 1, d));
    if (!time || real.getUTCFullYear() !== y || real.getUTCMonth() !== m - 1 || real.getUTCDate() !== d) return null;
    return { date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, ...time };
  }
  return null;
};

const readSubmission = (text) => {
  const found = text.replace(/\n/g, ' ').match(SUBMISSION_RE);
  if (!found) return { address: null, deadline: null };
  return {
    address: unquote(found[1].replace(/[.,]+$/, '')) || null,
    deadline: readDeadline(found[2]),
  };
};

/**
 * `77341100/2`: a CPV code and an item number, the shape e-auction's
 * invitations use. Anchored on the whole cell, so an AMD amount — 8 digits as
 * well — is never read as a code.
 */
const CPV_CELL_RE = /^(\d{8})\s*\/\s*\d+$/;

/**
 * The lot table: the first whose header starts «Չափաբաժինների» ("lot
 * numbers"). A data row is a lot number (or nothing), the lot's budget, an
 * optional CPV cell and the lot name, which is the last cell. Header rows are
 * the ones with no amount in them.
 *
 * Some buyers leave every number blank; the table is then still the list of
 * lots, in order, and they are numbered by position. A table with some
 * numbers and some blanks keeps only the numbered rows — a blank there is a
 * continuation line, not a lot.
 */
const readLots = ($) => {
  const table = $('w\\:tbl')
    .filter((_, tbl) => /^Չափաբաժին/u.test(cellText($, $(tbl).find('w\\:tc').first())))
    .first();
  if (!table.length) return [];

  const rows = [];
  table.children('w\\:tr').each((_, tr) => {
    const cells = $(tr).children('w\\:tc').map((__, tc) => cellText($, tc)).get();
    if (cells.length < 3) return;
    const amount = cells[1].replace(/[\s,]/g, '');
    if (!/^\d+(?:\.\d+)?$/.test(amount)) return;
    const cpv = cells.slice(2, -1).map((c) => c.match(CPV_CELL_RE)).find(Boolean);
    const name = cells[cells.length - 1] || null;
    if (!name) return;
    rows.push({ number: /^\d+$/.test(cells[0]) ? Number(cells[0]) : null, cpvCode: cpv ? cpv[1] : null, name });
  });

  const numbered = rows.filter((row) => row.number !== null);
  const lots = numbered.length ? numbered : rows.map((row, i) => ({ ...row, number: i + 1 }));
  return lots.map(({ number, cpvCode, name }) => ({ lotNumber: number, cpvCode, name }));
};

const readDocument = (zip, entryName) => {
  const $ = wordDocument(zip);
  if (!$) return null;
  const text = documentText($);
  const submission = readSubmission(text);
  return {
    entryName,
    procedureCode: readCode(text),
    buyerName: readBuyer(text),
    subject: readSubject(text),
    submissionAddress: submission.address,
    deadline: submission.deadline,
    lots: readLots($),
    textLength: text.length,
  };
};

/** How many of the fields that matter a read found — the tiebreak between a zip's documents. */
const completeness = (doc) =>
  ['procedureCode', 'buyerName', 'submissionAddress', 'deadline'].filter((field) => doc[field] !== null).length;

/**
 * The Word documents in an upload: the upload itself when it is a .docx, or
 * every .docx one level inside a .zip. Nested archives are not opened.
 */
const readWordDocuments = (bytes) => {
  const format = fileFormat(bytes);
  if (format !== 'zip') return { format, documents: [] };
  let zip;
  try {
    zip = new AdmZip(bytes);
  } catch {
    return { format: 'unknown', documents: [] };
  }

  const asWord = readDocument(zip, null);
  if (asWord) return { format: 'docx', documents: [asWord] };

  const documents = zip
    .getEntries()
    .filter((entry) => !entry.isDirectory && /\.docx$/i.test(entry.entryName))
    .map((entry) => {
      try {
        return readDocument(new AdmZip(entryData(entry)), entry.entryName);
      } catch {
        // One unreadable member does not make the others unreadable.
        return null;
      }
    })
    .filter(Boolean);
  return { format: 'zip', documents };
};

/**
 * One upload → what it says.
 *
 * A zip usually holds the Armenian invitation beside its Russian and English
 * copies and annexes. The one read is the one the template's sentences are
 * found in — the Armenian text; the translations do not carry them. Most
 * fields found wins, then the longer text, then the zip's own order, so the
 * pick is stable across replays.
 *
 * @returns {{ format: string, readable: boolean, document: object|null }}
 *   `format` is what the bytes are: `docx`, `zip`, `doc`, `rar`, `7z`, `pdf`
 *   or `unknown`.
 */
export const parseInvitation = (bytes) => {
  const { format, documents } = readWordDocuments(bytes);
  const [document = null] = documents
    .filter((doc) => doc.buyerName !== null || doc.submissionAddress !== null)
    .sort((a, b) => completeness(b) - completeness(a) || b.textLength - a.textLength);

  // ── The format check ──────────────────────────────────────────────────────
  // Sergey: only .docx, and .docx inside a .zip, are read today — and only
  // when the Armenian announcement template is found in it. Everything else
  // comes back `readable: false`: old .doc, .rar, .7z, .pdf, a zip whose
  // Armenian invitation is itself inside a .rar (only its Russian or English
  // copy is a .docx), and a Word file that is a pasted scan. The normalizer
  // records each as an `unsupported_format` unmatched result, and no tender.
  //
  // That is deliberate, not a gap nobody noticed. These formats are counted
  // so that the numbers, not a guess, decide which converter is worth adding
  // (LibreOffice for .doc, unrar and 7z for archives; OCR for scans is likely
  // never worth it at ~4% of contract value). They are meant to become
  // supported. The raw file is stored either way, so a converter added later
  // replays from storage (`npm run normalize:replay`) without re-crawling
  // gnumner. Which formats matter:
  //
  //   select substring(p.storage_key from '\.([a-z0-9]+)$') as ext, count(*)
  //     from unmatched_results u
  //     join source_payloads p on p.source = u.source and p.hash = u.payload_hash
  //    where u.source = 'gnumner' and u.reason = 'unsupported_format' and u.resolved_at is null
  //    group by 1 order by 2 desc;
  //
  // An amendment notice is never counted here: its content is not read, so it
  // attaches whatever its format (ticket 07).
  if (!document) return { format, readable: false, document: null };

  return { format, readable: true, document };
};

/**
 * The procedure code an amendment notice states in its body, read only when
 * its title names none (decided 2026-10-21, ticket 07): «Ընթացակարգի
 * ծածկագիրը …», the line both the Article 29 template and a full invitation
 * carry. Nothing else in a notice is read. Null for anything that is not a
 * Word document (.docx, or one inside a .zip) and for one that states no code;
 * either way the notice keeps whatever its title gave it.
 */
export const noticeBodyCode = (bytes) => {
  const { documents } = readWordDocuments(bytes);
  return documents.map((doc) => doc.procedureCode).find(Boolean) ?? null;
};

export default { parseInvitation, noticeBodyCode, fileFormat };
