import * as cheerio from 'cheerio';
import { readXls } from '../../spreadsheet/xls.js';
import { fromArmsciiFont, hasUndecoded } from '../../../armscii.js';

/**
 * Pure: the CPV classifier as gnumner publishes it (cpv-inference ticket 01,
 * ADR 0006) — where its files are linked, which date a file states, and the
 * code sheet read out of it.
 *
 * Two files. The full list, «Գնումների միասնական անվանացանկ», and the
 * e-auction subset, «Էլեկտրոնային աճուրդի միջոցով ձեռքբերվող գնման
 * առարկաների թվային ծածկագրեր». Both are uploads whose file name changes
 * with every update (CPV-11.11.2026.xls, 16.10.2026.xls), so a file is found
 * by the label of the link that points at it, never by its name.
 */

const LABELS = {
  full: (label) => /միասնական\s+անվանացանկ/u.test(label),
  eauction: (label) => /Էլեկտրոնային\s+աճուրդի/u.test(label) && /CPV/.test(label),
};

const UPLOAD_PREFIX = '/website/images/';

/**
 * The upload path of each file, from any gnumner page (every page's footer
 * links both). A link is accepted only to an upload on gnumner's own host,
 * and returned as its percent-encoded path: the caller builds the URL from
 * the configured base, so scraped content never chooses where it connects.
 *
 * Every link to a file must agree — the home page links the full list twice —
 * and a missing or ambiguous one throws: a redesigned footer is a refresh
 * that fails loudly, not one that quietly reads the wrong file.
 */
export const findClassifierLinks = (html, { baseUrl, host }) => {
  const $ = cheerio.load(html);
  const found = { full: new Set(), eauction: new Set() };

  $('a[href]').each((_, el) => {
    const label = `${$(el).text()} ${$(el).attr('title') ?? ''}`.replace(/\s+/g, ' ');
    let url;
    try {
      url = new URL($(el).attr('href'), baseUrl);
    } catch {
      return;
    }
    if (url.host !== host || !url.pathname.startsWith(UPLOAD_PREFIX)) return;
    for (const [kind, matches] of Object.entries(LABELS)) if (matches(label)) found[kind].add(url.pathname);
  });

  for (const [kind, paths] of Object.entries(found)) {
    if (paths.size !== 1) {
      throw new Error(
        `[gnumner] CPV classifier: ${paths.size ? `${paths.size} different` : 'no'} ${kind} link(s) on the page` +
          (paths.size ? `: ${[...paths].join(', ')}` : ' — has the footer changed?')
      );
    }
  }
  return { full: [...found.full][0], eauction: [...found.eauction][0] };
};

/**
 * The date a file's name states, as `YYYY-MM-DD` — the ministry dates each
 * update in it (CPV-11.11.2026.xls). Null when the name states none or an
 * impossible one; the caller decides what else to trust.
 */
export const fileDate = (path) => {
  const name = decodeURIComponent(String(path).split('/').pop());
  const m = name.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(iso) ? iso : null;
};

/**
 * A code cell as 8 digits. Excel stores about half the codes as numbers, so
 * 3000000-something would lose its leading zero: a whole number is padded.
 * A text cell must already be 8 digits; a short one is not guessed at.
 */
const codeOf = (cell) => {
  if (typeof cell === 'number') {
    return Number.isInteger(cell) && cell >= 0 && cell < 1e8 ? String(cell).padStart(8, '0') : null;
  }
  const text = String(cell ?? '').trim();
  return /^\d{8}$/.test(text) ? text : null;
};

/** A name or unit as Unicode, with the font's runs of spaces collapsed; null when empty. */
const textOf = (cell) => {
  if (cell === undefined || cell === null) return null;
  const text = fromArmsciiFont(cell).replace(/\s+/g, ' ').trim();
  return text || null;
};

/**
 * The code sheet of one classifier file: `{ sheet, entries, skipped, undecoded }`.
 *
 * The sheet is the one whose first column holds the most codes — the full
 * list's is "Sheet2", between a title page and a unit table, the subset's
 * "Sheet1" — so a renamed or reordered sheet is still found. Columns are code,
 * name, unit; the subset has no unit column and every unit is then null.
 *
 * A row of that sheet that is not a code with a name is counted in `skipped`
 * with its reason, never dropped silently; a repeated code keeps its first
 * row. `undecoded` lists the codes whose name or unit still holds a character
 * the font table does not map.
 */
export const parseClassifier = (buffer) => {
  const sheets = readXls(buffer);
  const codeRows = (sheet) => sheet.rows.filter((row) => row && codeOf(row[0])).length;
  const sheet = sheets.reduce((best, s) => (codeRows(s) > codeRows(best) ? s : best), sheets[0]);
  if (!sheet || !codeRows(sheet)) throw new Error('[gnumner] CPV classifier: no sheet holds CPV codes');

  const entries = [];
  const seen = new Set();
  const skipped = [];
  const undecoded = [];

  sheet.rows.forEach((row, index) => {
    if (!row || row.every((cell) => cell === undefined || String(cell).trim() === '')) return;
    const code = codeOf(row[0]);
    const name = textOf(row[1]);
    if (!code) return skipped.push({ row: index + 1, reason: 'no_code', value: String(row[0] ?? '') });
    if (!name) return skipped.push({ row: index + 1, reason: 'no_name', value: code });
    if (seen.has(code)) return skipped.push({ row: index + 1, reason: 'duplicate', value: code });
    seen.add(code);
    const unit = textOf(row[2]);
    if (hasUndecoded(name) || (unit && hasUndecoded(unit))) undecoded.push(code);
    entries.push({ code, name, unit });
    return undefined;
  });

  return { sheet: sheet.name, entries, skipped, undecoded };
};

export default { findClassifierLinks, fileDate, parseClassifier };
