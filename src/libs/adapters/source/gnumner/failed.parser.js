import { extractProcedureCode } from './listing.parser.js';
import { armenianPart, cellText, isBlank, wordDocuments } from './word.js';

/**
 * Pure: the bytes of one upload on gnumner's «Չկայացած գնման ընթացակարգի
 * մասին հայտարարություն» listing in, what the notice says out. No network,
 * no database, no clock, so a replay from storage reads what the first run
 * read.
 *
 * The notice is the Ministry of Finance template of order 235-Ա (2022,
 * Annex 13), «ՀԱՅՏԱՐԱՐՈՒԹՅՈՒՆ գնման ընթացակարգը չկայացած հայտարարելու
 * մասին». Verified on 2026-10-23 against 32 live uploads (29 .docx and .zip
 * among the listing's first twelve pages, three more from pages 15–17):
 *
 *   Ընթացակարգի ծածկագիրը՝ ՀՀԱՆ-ԳՀԱՊՁԲ-26/35
 *   <buyer> ստորև ներկայացնում է … ծածկագրով գնման ընթացակարգը չկայացած հայտարարելու մասին տեղեկատվությունը`
 *   Չափաբաժնի համար | Գնման առարկայի … | … մասնակիցների անվանումները | … չկայացած է հայտարարվել համաձայն` … 37-րդ հոդվածի 1-ին մասի | … հիմնավորման …
 *   1 | Համակարգիչ ամբողջը մեկում | «ԼԱԳԱ 1820» ՍՊԸ … | 1-ին կետի 2-րդ կետի … | Մասնակիցների … չեն համապատասխանում …
 *
 * **The table lists the lots that failed, not the procedure's.** A buyer
 * whose lots 1–4, 25–32 and 39 failed lists those rows and leaves the
 * template's sentence saying the whole procedure did (Թ4ՊՈԼ-ԳՀԱՊՁԲ-26/34); one
 * whose lot 2 failed writes «… 2-րդ չափաբաժնի մասով …» and lists lot 2
 * (ՎԱ-ՍԱՏՄ-ԳՀԾՁԲ-27/10). So the sentence is not read, and whether the whole
 * tender failed is decided against the tender's own lots
 * (resolution.service.js#failureStatus), never here.
 *
 * What varies, all seen: the lot as «1» or «1.»; a lot cell left blank on
 * every row (2 of the 32 — «Դիզելային վառելիք» alone, or ten food items),
 * which are rows the table does not place and are not read; a bidder per
 * extra row with the lot and subject cells blank (a continuation, not a
 * lot); the first header cell «Չափաբաժին» instead of «Չափաբաժնի համար»; a
 * Russian translation glued onto each cell («Չափաբաժնի համարНомер лота»), or
 * as a second table, or as a second file in a .zip — only the Armenian
 * table is read, so a .zip whose Armenian notice is a .doc is not read from
 * its Russian .docx.
 */

/** The template's table: its first header cell names the lot, and a header cell says the procedure failed. */
const isFailureTable = (header) =>
  /^Չափաբաժ/u.test(header[0] ?? '') && header.some((cell) => /չկայացած/u.test(cell));

/**
 * «1», «1.», «1-ին», «Չափաբաժին 1» → [1]; «1, 2» → [1, 2]; «1-3» → [1, 2, 3]; anything else
 * (a blank, words) → null. A range is read only when it is short and
 * ascending: a typed «1-47» is 47 lots, but a cell reading «2026-10» is not.
 */
const lotNumbersOf = (text) => {
  const cell = armenianPart(text)
    .replace(/\s+/g, '')
    .replace(/^Չափաբաժին/u, '')
    .replace(/(?:-?(?:ին|րդ))?\.?$/u, '');
  if (/^\d+$/.test(cell)) return [Number(cell)];
  const range = cell.match(/^(\d+)[-–](\d+)$/);
  if (range) {
    const [lo, hi] = [Number(range[1]), Number(range[2])];
    return hi > lo && hi - lo < 100 ? Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) : null;
  }
  if (/^\d+(?:[,;]\d+)+$/.test(cell)) return cell.split(/[,;]/).map(Number);
  return null;
};

/**
 * The procedure code, from «Ընթացակարգի ծածկագիրը՝ …» or the sentence that
 * presents the notice — the first paragraph naming a code beside the word
 * «ծածկագ…» — through the listing parser's rule, so there is one definition
 * of a code. The caller asks for it only when the title names none.
 */
const readCode = (paragraphs) => {
  for (const text of paragraphs) {
    if (!/ծածկագ/u.test(text)) continue;
    const code = extractProcedureCode(text.replace(/[«»"“”<>]/g, ' '));
    if (code) return code;
  }
  return null;
};

/**
 * The failed lots, from the template's table. A row whose lot cell names a
 * number is that lot; one with a blank lot cell and a subject is a row the
 * table does not place (`unplacedRows`), counted and not read — a position is
 * not a lot number when the table lists only the lots that failed; one with
 * both blank is a bidder's continuation line.
 */
const readLots = ($, table) => {
  const lots = new Set();
  let unplacedRows = 0;
  table
    .children('w\\:tr')
    .slice(1)
    .each((_, tr) => {
      const cells = $(tr).children('w\\:tc').map((__, tc) => cellText($, tc)).get();
      if (cells.every(isBlank)) return;
      const numbers = lotNumbersOf(cells[0] ?? '');
      if (numbers) {
        for (const lot of numbers) lots.add(lot);
        return;
      }
      if (!isBlank(cells[0] ?? '')) return;
      if (!isBlank(cells[1] ?? '')) unplacedRows += 1;
    });
  return { lots: [...lots].sort((a, b) => a - b), unplacedRows };
};

const readNotice = ($, entryName) => {
  const table = $('w\\:tbl')
    .filter((_, tbl) => {
      const header = $(tbl).children('w\\:tr').first().children('w\\:tc').map((__, tc) => cellText($, tc)).get();
      return isFailureTable(header);
    })
    .first();
  const paragraphs = $('w\\:p')
    .map((_, p) => cellText($, p))
    .get()
    .filter(Boolean);
  return {
    entryName,
    procedureCode: readCode(paragraphs),
    tableFound: table.length > 0,
    ...(table.length ? readLots($, table) : { lots: [], unplacedRows: 0 }),
  };
};

/**
 * One upload → what the failed-procedure notice says.
 *
 * @returns {{ format: string, readable: boolean, notice: object|null }}
 *   `notice` is `{ entryName, procedureCode, lots, unplacedRows }` —
 *   `entryName` the .docx inside a .zip, null for a .docx; `lots` the lot
 *   numbers the table lists as failed, ascending; `unplacedRows` the rows it
 *   lists with no lot number, which are not read.
 */
export const parseFailedNotice = (bytes) => {
  const { format, documents } = wordDocuments(bytes, readNotice);
  const [found = null] = documents
    .filter((doc) => doc.tableFound)
    .sort((a, b) => b.lots.length - a.lots.length);

  // ── The format check ──────────────────────────────────────────────────────
  // Sergey: as for invitations and contract notices, only .docx, and .docx
  // inside a .zip, are read today — and only when the Armenian table of the
  // 235-Ա template is found in it. Everything else comes back
  // `readable: false`: old .doc, .rar, .pdf (scans, often), a .zip whose
  // Armenian notice is a .doc beside a Russian .docx, and a Word file that is
  // not the template. Which lots failed is the point of the notice — a
  // partly failed procedure must not cancel the tender — so unlike an
  // amendment notice it cannot attach unread. paper.js records each as an
  // `unsupported_format` unmatched result and changes no tender.
  //
  // That is deliberate, not a gap nobody noticed. They are counted so that
  // the numbers, not a guess, decide which converter is worth adding
  // (LibreOffice for .doc, unrar for archives, OCR for scans). They are meant
  // to become supported. The raw file is stored either way, so a converter
  // added later re-reads them from storage. On the listing's first thirty
  // pages (2026-10-23, 180 notices): 74 .docx, 41 .doc, 38 .pdf, 21 .rar,
  // 6 .zip — 25 of them e-auctions, which resolution skips before the format
  // is asked. The format-count query is in invitation.parser.js; failed
  // notices are its `failed` kind.
  if (!found) return { format, readable: false, notice: null };

  const { tableFound, ...notice } = found;
  return { format, readable: true, notice };
};

export default { parseFailedNotice };
