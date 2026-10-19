import AdmZip from 'adm-zip';
import * as cheerio from 'cheerio';

/**
 * The invitation archive -> the three fields that exist nowhere else.
 *
 * Verified across 5 live archives on 2026-08-17. Every one contains exactly
 * `hraver.docx` (Armenian) and `hraver_ru.docx` (Russian); the remaining
 * entries are per-lot technical specifications whose format varies wildly —
 * across 43 sampled entries: 18 .xls, 11 .rar, 11 .docx, 3 .xlsx. Only
 * hraver.docx is opened here. That is also why RAR support is not needed:
 * nothing this stage reads is ever a RAR.
 *
 * Those spec entries are currently read by NOTHING — the AI checklist stage
 * consumes the .txt derived from hraver.docx, not them. Wiring them in is an
 * open piece of work, and two measured facts should shape it: the "per-lot"
 * archives can be byte-identical to each other (tid 47009: one sha256 across
 * all five), and ~98% of each is a generic bilingual memo PDF wrapping a ~23 KB
 * ՏԲ.docx that holds the actual specification. Dedupe by content hash before
 * attributing anything to a lot. See docs/SCRAPER_WORKFLOW.md § 5.
 *
 * A .docx is itself a ZIP whose `word/document.xml` holds the content.
 *
 * NEVER regex that XML. Word stores revision-save identifiers as `w:rsidR`
 * attributes, which are 8 hex digits and therefore indistinguishable by shape
 * from a CPV code. A regex sweep over the raw markup pulled 1,370,456
 * characters of "text" and harvested rsids as CPV codes; parsing the XML
 * properly yields 256,389 characters and only genuine content. Roughly 80% of
 * what a regex sees is editing metadata.
 */

const DOC_ENTRY = 'hraver.docx';

/**
 * Cap on each decompression layer, checked against the entry's declared
 * uncompressed size before any data is expanded.
 *
 * The download cap alone is not enough: this opens two nested archives (the
 * outer ZIP, then hraver.docx which is itself a ZIP), so a 60 MB archive that
 * passes the wire check can still expand to gigabytes across those layers. ZIP
 * central directories carry the uncompressed size, so this costs nothing to
 * read.
 */
const MAX_ENTRY_BYTES = 80 * 1024 * 1024;

/**
 * Buyer tax ID.
 *
 * Global on purpose. Taking the FIRST match in a ~250,000-character document
 * silently attributes whichever tax number appears earliest — a procuring
 * agent, a guarantee issuer, a worked example in the boilerplate — to the
 * buyer, and `setTaxId` only ever fills a blank, so a wrong value becomes
 * permanent with no signal. A value is returned only when the whole document
 * agrees on exactly one.
 */
const TAX_ID_RE = /ՀՎՀՀ[`\s:\-]*(\d{8})/g;

const extractTaxId = (text) => {
  const found = new Set();
  for (const match of text.matchAll(TAX_ID_RE)) found.add(match[1]);
  // Ambiguous -> null. A missing tax ID is recoverable; a confidently wrong one
  // attached to the wrong company is not.
  return found.size === 1 ? [...found][0] : null;
};

/**
 * A CPV cell reads `33141211/32` — the CPV code plus an item sequence number.
 *
 * The `/N` suffix is load-bearing for identification: bare 8-digit numbers in
 * these documents are AMD amounts (10200000, 12960000 appear as budget figures
 * in the very same file). Anchoring on the table column AND requiring the
 * suffix is what keeps money out of the CPV field.
 */
const CPV_CELL_RE = /^(\d{8})\/(\d+)$/;

/** Header of the column holding the CPV/plan code. */
const CPV_HEADER = 'ծածկագիր';

const cellText = ($, cell) =>
  $(cell)
    .find('w\\:t, t')
    .map((_, t) => $(t).text())
    .get()
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

/** Whole-document plain text, paragraph per line. */
const documentText = ($) =>
  $('w\\:p, p')
    .map((_, p) =>
      $(p)
        .find('w\\:t, t')
        .map((_, t) => $(t).text())
        .get()
        .join('')
    )
    .get()
    .join('\n');

/**
 * Per-lot rows from the invitation's lot table.
 *
 * Located by finding the row whose cells contain a CPV-shaped value, then
 * reading its siblings — rather than by fixed column index, because the table
 * has merged header cells whose count does not match the data rows.
 */
const parseLotTable = ($) => {
  const lots = [];

  /**
   * Document-scoped on purpose, NOT per-table.
   *
   * These invitations routinely list the same lots twice — a summary table and
   * a detail table. Measured across the 5 sampled archives: 36 raw rows -> 18
   * lots, 12 -> 6, 10 -> 5. The deduplicated count is the correct one: 18
   * matches the 18 `lot_N_i_texnikakan_bnutagir.xls` spec files in that same
   * archive, 5 matches its 5 spec files, 6 matches its 6.
   *
   * Scoping this per table would double every lot count and skew the CPV
   * frequency that `dominantCpv` is chosen from. The key includes the CPV cell,
   * so a lot genuinely carrying a different code in a second table is still
   * kept — only exact repeats collapse.
   */
  const seen = new Set();

  $('w\\:tbl, tbl').each((_, tbl) => {
    const $rows = $(tbl).find('w\\:tr, tr');
    // Locate the CPV column from the header, falling back to scanning cells.
    let cpvColumn = -1;
    const headerCells = $rows.first().find('w\\:tc, tc');
    headerCells.each((index, cell) => {
      if (cellText($, cell).toLowerCase().includes(CPV_HEADER)) cpvColumn = index;
    });

    $rows.each((rowIndex, tr) => {
      if (rowIndex === 0) return;
      const cells = $(tr).find('w\\:tc, tc');
      if (!cells.length) return;

      let cpvRaw = cpvColumn >= 0 ? cellText($, cells.get(cpvColumn)) : '';
      let match = CPV_CELL_RE.exec(cpvRaw);

      if (!match) {
        // Column index did not hold it (merged headers shift the mapping);
        // fall back to the first cell in the row that is CPV-shaped.
        cells.each((_, cell) => {
          if (match) return;
          const text = cellText($, cell);
          const candidate = CPV_CELL_RE.exec(text);
          if (candidate) {
            match = candidate;
            cpvRaw = text;
          }
        });
      }
      if (!match) return;

      const lotNumber = Number.parseInt(cellText($, cells.get(0)), 10);
      // The description is the longest non-code cell on the row.
      const name = cells
        .map((_, cell) => cellText($, cell))
        .get()
        .filter((text) => text && text !== cpvRaw && !/^\d+$/.test(text))
        .sort((a, b) => b.length - a.length)[0];

      const key = `${lotNumber}:${cpvRaw}`;
      if (seen.has(key)) return;
      seen.add(key);

      lots.push({
        lotNumber: Number.isFinite(lotNumber) ? lotNumber : null,
        cpvCode: match[1],
        itemSequence: Number(match[2]),
        name: name || null,
      });
    });
  });

  return lots;
};

/**
 * @param {Buffer} zipBuffer the invitation archive as downloaded
 * @returns {{ taxId: string|null, lots: object[], cpvCodes: string[],
 *            dominantCpv: string|null, text: string, entries: string[] }}
 */
export const parseInvitation = (zipBuffer) => {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries().map((entry) => entry.entryName);

  const empty = { taxId: null, lots: [], cpvCodes: [], dominantCpv: null, text: '', entries };

  const docEntry = zip.getEntry(DOC_ENTRY);
  if (!docEntry) return empty;

  // Declared uncompressed size, read from the central directory — checked
  // BEFORE getData() expands anything.
  if (docEntry.header.size > MAX_ENTRY_BYTES) {
    throw new Error(
      `${DOC_ENTRY} declares ${docEntry.header.size} bytes uncompressed, over the ${MAX_ENTRY_BYTES} cap`
    );
  }

  const docXml = new AdmZip(docEntry.getData()).getEntry('word/document.xml');
  if (!docXml) return empty;

  if (docXml.header.size > MAX_ENTRY_BYTES) {
    throw new Error(
      `word/document.xml declares ${docXml.header.size} bytes uncompressed, over the ${MAX_ENTRY_BYTES} cap`
    );
  }

  const $ = cheerio.load(docXml.getData().toString('utf8'), { xmlMode: true });

  const text = documentText($);
  const taxId = extractTaxId(text);
  const lots = parseLotTable($);

  // One tender can span several CPV codes (one archive sampled had 18 distinct
  // ones). `tenders.cpv_code` holds a single value, so the most frequent wins
  // and the full per-lot mapping is returned for storage alongside.
  const frequency = new Map();
  for (const lot of lots) frequency.set(lot.cpvCode, (frequency.get(lot.cpvCode) ?? 0) + 1);
  const dominantCpv = [...frequency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    taxId,
    lots,
    cpvCodes: [...frequency.keys()].sort(),
    dominantCpv,
    text,
    entries,
  };
};

export default { parseInvitation };
