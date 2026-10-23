import AdmZip from 'adm-zip';
import * as cheerio from 'cheerio';

/**
 * Pure: the Word plumbing every gnumner upload parser shares — what a file
 * is by its first bytes, and the .docx documents in it, parsed as XML. The
 * invitation parser and the contract-notice parser each read their own
 * template out of what this returns.
 *
 * As in eauction/invitation.parser.js, a .docx is read as XML, never with a
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
export const documentText = ($) =>
  $('w\\:p')
    .map((_, p) => runText($, p).replace(/\s+/g, ' ').trim())
    .get()
    .filter(Boolean)
    .join('\n');

export const cellText = ($, cell) => runText($, cell).replace(/\s+/g, ' ').trim();

export const CYRILLIC = /[Ѐ-ӿ]/u;
export const ARMENIAN = /[Ա-և]/u;

/**
 * A cell with its Russian translation glued on («ԲԵԼՄԵՏ ՍՊԸБЕЛМЕТ ООО»): the
 * Armenian part. A bilingual notice does this to every cell.
 */
export const armenianPart = (text) => {
  const at = text.search(CYRILLIC);
  return at > 0 && ARMENIAN.test(text.slice(0, at)) ? text.slice(0, at).trim() : text.trim();
};

/** An empty cell, or one a buyer filled with a dash or an ellipsis to say so. */
export const isBlank = (text) => /^[\s\-–—…․.]*$/u.test(text);

/**
 * The Word documents in an upload, each handed to `read($, entryName)`: the
 * upload itself when it is a .docx, or every .docx one level inside a .zip.
 * Nested archives are not opened. `format` is what the bytes are — `docx`
 * for a Word file, `zip` for an archive of them, otherwise what `fileFormat`
 * says.
 */
export const wordDocuments = (bytes, read) => {
  const format = fileFormat(bytes);
  if (format !== 'zip') return { format, documents: [] };
  let zip;
  try {
    zip = new AdmZip(bytes);
  } catch {
    return { format: 'unknown', documents: [] };
  }

  const asWord = wordDocument(zip);
  if (asWord) return { format: 'docx', documents: [read(asWord, null)] };

  const documents = zip
    .getEntries()
    .filter((entry) => !entry.isDirectory && /\.docx$/i.test(entry.entryName))
    .map((entry) => {
      try {
        const $ = wordDocument(new AdmZip(entryData(entry)));
        return $ ? read($, entry.entryName) : null;
      } catch {
        // One unreadable member does not make the others unreadable.
        return null;
      }
    })
    .filter(Boolean);
  return { format: 'zip', documents };
};

export default { fileFormat, documentText, cellText, armenianPart, isBlank, wordDocuments };
