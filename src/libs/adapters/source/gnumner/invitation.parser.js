import { extractProcedureCode } from './listing.parser.js';
import { cellText, documentText, fileFormat, wordDocuments } from './word.js';
import { agreedTaxId, beneficiaryTaxIds } from '../../../taxId.js';

export { fileFormat };

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
 * The Word plumbing — formats, opening a .docx as XML — is word.js's.
 */

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
 *     հաշված N-րդ օրվա» ("counted from the day after publication"), or «…
 *     հրապարակման օրվան հաջորդող օրվանից», and their own bid-opening dates are
 *     still publication + N (8, 41 and 7, all seen): the same arithmetic,
 *     because the count starts the day after either way.
 *   - a date: «… մինչև 27.10.2026թ օրվա ժամը 12:30», also as 26,10,2026;
 *     or in words, «… մինչև 2026 թվականի Հոկտեմբերի 16-ին ժամը 12:00», also
 *     after a day count whose «օրվա» it replaces («… հաշված 7 -րդ օրը՝ 2026
 *     թվականի սեպտեմբերի 11-ին ժամը 11։00»), where the date is read.
 *
 * Spellings seen: «8- րդ», «“7”րդ», «ժամը 16,30», «11։00» (Armenian colon).
 * A buyer who leaves the address blank («ներկայացնել հասցեով, …») still states
 * the deadline: the address is null and the deadline is read. Some put a mark
 * after the verb («ներկայացնել` ՀՀ, Ք. Երևան, …»); a letter after it is
 * another word («ներկայացնելու»), never this sentence.
 *
 * A day counted from when the invitation was SENT to a supplier («… հրավերը
 * հնարավոր մասնակցին ուղարկվելու օրվանից հաշված 7-րդ օրվա …», ticket 37) is
 * not read: gnumner does not say when that was, and publication + N would be
 * later than the real deadline whenever the buyer sent it first. The
 * deadline is then the listing's close, or none (observation.js).
 */
const SUBMISSION_RE =
  /ներկայացնել(?:\s*[`՝’']\s*|\s+)(.*?)\s*հասցե(?:ով|ում)\s*,?\s*փաստաթղթային\s+ձևով(.{0,240})/u;

/**
 * The bid-opening sentence (ticket 37): «Հայտերի բացումը տեղի կունենա
 * <address> հասցեում, «2026» «հոկտեմբերի» «26»-ին ժամը 17:00-ին». Read from
 * the address on, in the forms the deadline is: a date in figures or in
 * words, a day count, and a month and day with no year («սույն թվականի
 * հոկտեմբերի 15-ին», "of this year"). Some buyers state only the hour, and
 * then it is null.
 *
 * Not a deadline fallback: it equals the deadline in 52 of 60 stored
 * invitations, and opens after it in 3 (observation.js). Production does not
 * read it; `sources:verify` counts how often it agrees, so that decision can
 * be checked again as invitations accumulate.
 */
const OPENING_RE = /Հայտերի\s+բացումը\s+տեղի\s+(.{0,320})/u;

/** Where a sentence ends: a full stop before the next capital, never the colon of «11։00». */
const sentence = (tail) => tail.split(/[:։]\s+(?=[Ա-Ֆ])/u)[0];

// «ժամը 12:00», «, ժամը՝ 12:00», «ժամը _15։20_», and «ժամը 11-ին» (on the hour).
const TIME = '[\\s,`՝’\']*ժամը\\s*[`՝’\':_]*\\s*(\\d{1,2})(?:\\s*[:։.․,]\\s*(\\d{2}))?';
const DAY_COUNT_RE = new RegExp(
  `հրապարակման\\s+(?:(?:օրվան\\s+)?հաջորդ(?:ող)?\\s+)?օրվանից\\s+(?:հաշված\\s+)?[«"“(]?\\s*(\\d{1,2})\\s*[»"”)]?\\s*-?\\s*(?:րդ)?\\s*օր(?:վա|ը|ն)?${TIME}`,
  'u'
);
// «27.10.2026թ օրվա ժամը», «12.10.2026թ-ին ժամը», «14.10.2026թ., ժամը՝», «15.10.2026 թ-ին ժամը».
const DATE_RE = new RegExp(
  `(\\d{1,2})[.,](\\d{1,2})[.,](\\d{4})\\s*թ?\\s*[.․]?\\s*(?:-\\s*ին|օրվա)?${TIME}`,
  'u'
);
// Read with the quote marks taken out: «2026 թվականի սեպտեմբերի 30-ին», «2026թ-ի
// Հոկտեմբերի 01-ին», «2026 թ. հոկտեմբերի 26-ին», «2026թ հոկտեմբերի 21-ը»,
// «սույն թվականի հոկտեմբերի 05-ին», «հոկտեմբերի 15-ին».
const WORD_DATE_RE = new RegExp(
  `(?:(\\d{4})\\s*(?:թվականի|թ\\s*[.․]?\\s*(?:-\\s*ի)?)?\\s*|սույն\\s+թվականի\\s+)?([\\u0531-\\u0556\\u0561-\\u0587]+ի)\\s+(\\d{1,2})\\s*-?\\s*(?:ին|ը)${TIME}`,
  'u'
);

/**
 * A genitive month name by its first letters, so a misspelling still reads
 * («հոկտեմեբրի», «հոկտոմբորի» are both seen). The genitive «-ի» is required
 * by WORD_DATE_RE, which keeps a street named after a month («Հոկտեմբերյան
 * 2») from being read as one.
 */
const MONTHS = [
  ['հունվ', 1], ['փետր', 2], ['մարտ', 3], ['ապր', 4], ['մայ', 5], ['հունի', 6],
  ['հուլ', 7], ['օգոս', 8], ['սեպտ', 9], ['հոկտ', 10], ['նոյ', 11], ['դեկ', 12],
];
const monthOf = (word) => MONTHS.find(([prefix]) => word.toLowerCase().startsWith(prefix))?.[1] ?? null;

const pad2 = (n) => String(n).padStart(2, '0');
const clock = (hour, minute = '00') =>
  Number(hour) <= 23 && Number(minute) <= 59 ? { hour: Number(hour), minute: Number(minute) } : null;

/** A date the calendar does not have («31.09») is a typo, not the 1st of the next month. */
const realDate = (y, m, d) => {
  const real = new Date(Date.UTC(y, m - 1, d));
  return real.getUTCFullYear() === y && real.getUTCMonth() === m - 1 && real.getUTCDate() === d;
};

// A date with no year is checked against a leap year, so «29 February» stands until a year is known.
const LEAP_YEAR = 2028;

const dated = (y, m, d, time) => {
  if (!time || !m || !realDate(y ?? LEAP_YEAR, m, d)) return null;
  // No year: «սույն թվականի» ("of this year") or none written. The year is
  // the publication's, which only observation.js knows.
  if (y === null) return { monthDay: `${pad2(m)}-${pad2(d)}`, ...time };
  return y >= 2000 && y <= 2100 ? { date: `${y}-${pad2(m)}-${pad2(d)}`, ...time } : null;
};

/**
 * One sentence's "when": `{ day, hour, minute }` counted from publication,
 * `{ date }`, `{ monthDay }` with no year, or null.
 */
const readWhen = (text) => {
  const count = text.match(DAY_COUNT_RE);
  if (count) {
    const day = Number(count[1]);
    const time = clock(count[2], count[3]);
    return day >= 1 && day <= 60 && time ? { day, ...time } : null;
  }
  const figures = text.match(DATE_RE);
  if (figures) return dated(Number(figures[3]), Number(figures[2]), Number(figures[1]), clock(figures[4], figures[5]));
  const words = text.replace(/[«»"“”„]/g, ' ').replace(/\s+/g, ' ').match(WORD_DATE_RE);
  if (words) {
    const year = words[1] ? Number(words[1]) : null;
    return dated(year, monthOf(words[2]), Number(words[3]), clock(words[4], words[5]));
  }
  return null;
};

/**
 * The deadline sentence's time — never one counted from when the invitation
 * was sent: «ուղարկվելու» in what the day is counted from (up to the first
 * «օրվանից»), even beside «հրապարակման». A remark after the deadline that
 * mentions sending («…ժամը 15:30-ը:/ … հրավերն ուղարկվելու օրվանից երկու …»,
 * cf739305) is not that. And never a date with no year: none is seen in a
 * deadline sentence, and the year `paperDeadline` would give it is unchecked
 * there.
 */
const readSubmission = (text) => {
  const found = text.match(SUBMISSION_RE);
  if (!found) return { address: null, deadline: null };
  const tail = sentence(found[2]);
  const when = /ուղարկվ/u.test(tail.split('օրվանից')[0]) ? null : readWhen(tail);
  return {
    address: unquote(found[1].replace(/[.,]+$/, '')) || null,
    deadline: when?.monthDay ? null : when,
  };
};

const readOpening = (text) => {
  const found = text.match(OPENING_RE);
  if (!found) return null;
  // From the address on: an address holds figures («Կոմիտաս 54 բ») and,
  // once, a street named after a month.
  const at = found[1].search(/հասցե/u);
  return readWhen(sentence(at === -1 ? found[1] : found[1].slice(at)));
};

/**
 * `77341100/2`: a CPV code and an item number, the shape e-auction's
 * invitations use. Anchored on the whole cell, so an AMD amount — 8 digits as
 * well — is never read as a code.
 */
const CPV_CELL_RE = /^(\d{8})\s*\/\s*\d+$/;

/**
 * The budget cell of a lot row: an amount, as `61 469 813`, `3,999,000`,
 * `7.244.340` or `168․000` (U+2024, the dot Armenian keyboards type). Two
 * wordings around it are seen (ticket 36): «Մինչև 3999000» ("up to") and the
 * amount spelled out after it, «10 000 000 (տասը միլիոն ՀՀ դրամ)». Both are
 * taken off before the digits are checked; the amount itself is not kept, so
 * a dot need not be told apart as thousands or decimals.
 */
const isAmount = (cell) =>
  /^\d+(?:[.․]\d+)*$/u.test(
    cell
      .replace(/^Մինչև\s*/u, '')
      .replace(/\s*\(.*\)$/u, '')
      .replace(/[\s,]/g, '')
  );

/**
 * The lot table: the first whose header starts «Չափաբաժինների» ("lot
 * numbers"), or is the cell «Չափաբաժնի» alone — the singular some buyers
 * write, over «համարները» in the row below. «Չափաբաժնի համար» is the bid
 * form's table, not this one. A data row is a lot number (or nothing), the
 * lot's budget, an optional CPV cell and the lot name, which is the last
 * cell. Header rows are the ones with no amount in them.
 *
 * Some buyers leave every number blank; the table is then still the list of
 * lots, in order, and they are numbered by position. A table with some
 * numbers and some blanks keeps only the numbered rows — a blank there is a
 * continuation line, not a lot.
 *
 * `lotTable` says whether the table was found at all, so an invitation with
 * no lot table is told apart from one whose table no row was read from
 * (`sources:verify` counts both).
 */
const readLots = ($) => {
  const table = $('w\\:tbl')
    .filter((_, tbl) => /^Չափաբաժ(?:ին|նի$)/u.test(cellText($, $(tbl).find('w\\:tc').first())))
    .first();
  if (!table.length) return { lotTable: false, lots: [] };

  const rows = [];
  table.children('w\\:tr').each((_, tr) => {
    const cells = $(tr).children('w\\:tc').map((__, tc) => cellText($, tc)).get();
    if (cells.length < 3) return;
    if (!isAmount(cells[1])) return;
    const cpv = cells.slice(2, -1).map((c) => c.match(CPV_CELL_RE)).find(Boolean);
    const name = cells[cells.length - 1] || null;
    if (!name) return;
    rows.push({ number: /^\d+$/.test(cells[0]) ? Number(cells[0]) : null, cpvCode: cpv ? cpv[1] : null, name });
  });

  const numbered = rows.filter((row) => row.number !== null);
  const lots = numbered.length ? numbered : rows.map((row, i) => ({ ...row, number: i + 1 }));
  return { lotTable: true, lots: lots.map(({ number, cpvCode, name }) => ({ lotNumber: number, cpvCode, name })) };
};

const readDocument = ($, entryName) => {
  const text = documentText($);
  const flat = text.replace(/\n/g, ' ');
  const submission = readSubmission(flat);
  return {
    entryName,
    procedureCode: readCode(text),
    buyerName: readBuyer(text),
    subject: readSubject(text),
    submissionAddress: submission.address,
    deadline: submission.deadline,
    opening: readOpening(flat),
    ...readLots($),
    taxIds: beneficiaryTaxIds(text),
    textLength: text.length,
  };
};

/** How many of the fields that matter a read found — the tiebreak between a zip's documents. */
const completeness = (doc) =>
  ['procedureCode', 'buyerName', 'submissionAddress', 'deadline'].filter((field) => doc[field] !== null).length;

/** The Word documents in an upload, each read for the invitation template. */
const readWordDocuments = (bytes) => wordDocuments(bytes, readDocument);

/**
 * One upload → what it says.
 *
 * A zip usually holds the Armenian invitation beside its Russian and English
 * copies and annexes. The one read is the one the template's sentences are
 * found in — the Armenian text; the translations do not carry them. Most
 * fields found wins, then the longer text, then the zip's own order, so the
 * pick is stable across replays.
 *
 * @returns {Promise<{ format: string, readable: boolean, document: object|null }>}
 *   `format` is what the bytes are: `docx`, `zip`, `doc`, `rar`, `7z`, `pdf`
 *   or `unknown`.
 */
export const parseInvitation = async (bytes) => {
  const { format, documents } = await readWordDocuments(bytes);
  const [document = null] = documents
    .filter((doc) => doc.buyerName !== null || doc.submissionAddress !== null)
    .sort((a, b) => completeness(b) - completeness(a) || b.textLength - a.textLength);

  // ── The format check ──────────────────────────────────────────────────────
  // Sergey: a .docx is read, and so is every .docx inside an archive — a
  // .zip, a .rar or a .7z, and one more archive inside that (a zip whose
  // Armenian invitation is in a nested .rar) — since ticket 33 (2026-10-29),
  // and only when the Armenian announcement template is found in it. What a
  // file is comes from its bytes (word.js), never its name. Everything else
  // comes back `readable: false`, and the normalizer records each as an
  // `unsupported_format` unmatched result and no tender:
  //
  //   - old .doc, and an archive whose Armenian invitation is a .doc beside a
  //     Russian .docx. The Russian copy is not the template and is never read
  //     as if it were;
  //   - PDFs, scanned or with a text layer;
  //   - an archive with no Word file in it (one .7z holds an .xls and a PDF),
  //     and an encrypted, corrupt or oversized one;
  //   - a Word file that is a pasted scan, or Word saved as HTML.
  //
  // Still deliberate, not a gap nobody noticed. On ticket 13's file-by-file
  // count, unrar and 7z were the only converters that recovered invitations,
  // so they came first. LibreOffice for .doc waits for production counts: what
  // it unlocks is mostly failure statuses and a few competitive contract
  // prices, and it costs a headless office suite in the worker image. OCR is
  // likely never worth it: every scan counted was single source or a failure
  // notice. The raw file is stored either way, with the notice that uploaded
  // it, so a converter added later replays from storage without re-crawling
  // gnumner: `npm run notices:replay -- --unmatched=unsupported_format`
  // (`normalize:replay` has no notice to count a deadline from, for a file
  // that never became a tender). Which formats are left, per kind of notice
  // and per procedure (ticket 31) — a single-source contract notice is a
  // price kept out of every comparison, so it should not choose the converter:
  //
  //   select case when u.external_ref like 'contract:%' then 'contract'
  //               when u.external_ref like 'failed:%' then 'failed'
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
  // An invitation's procedure is its listing's, so one recorded before the
  // column existed, and re-read with no notice beside it, says `unknown`.
  //
  // An amendment notice is never counted here: its content is not read, so it
  // attaches whatever its format (ticket 07).
  if (!document) return { format, readable: false, document: null };

  // The buyer's ՀՎՀՀ is read off every document of the upload, not only the
  // one picked: the guarantee form is often an annex of its own (ticket 19).
  const taxId = agreedTaxId(documents.flatMap((doc) => doc.taxIds));
  return { format, readable: true, document: { ...document, taxId } };
};

/**
 * The procedure code an amendment notice states in its body, read only when
 * its title names none (decided 2026-10-21, ticket 07): «Ընթացակարգի
 * ծածկագիրը …», the line both the Article 29 template and a full invitation
 * carry. Nothing else in a notice is read. Null for anything that is not a
 * Word document (.docx, or one inside an archive) and for one that states no code;
 * either way the notice keeps whatever its title gave it.
 */
export const noticeBodyCode = async (bytes) => {
  const { documents } = await readWordDocuments(bytes);
  return documents.map((doc) => doc.procedureCode).find(Boolean) ?? null;
};

export default { parseInvitation, noticeBodyCode, fileFormat };
