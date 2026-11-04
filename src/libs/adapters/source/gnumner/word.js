import AdmZip from 'adm-zip';
import * as cheerio from 'cheerio';
import { ArchiveError, unpack } from '../../archive/sevenzip.js';

/**
 * Pure: the Word plumbing every gnumner upload parser shares — what a file
 * is by its first bytes, and the .docx documents in it, parsed as XML. An
 * archive other than a zip is opened through the archive adapter
 * (libs/adapters/archive/sevenzip.js), which is why reading is async. The
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

/**
 * Cap on everything one upload unpacks to, across every layer: the per-entry
 * cap alone lets an archive of many entries, each just under it, fill the
 * worker's memory. Twice an entry's cap, and well past what any stored upload
 * needs: the download cap is 60 MB, and scans do not compress.
 */
const MAX_UNPACKED_BYTES = 2 * MAX_ENTRY_BYTES;

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

/** The archive formats an upload is opened as; `zip` is also what a .docx is. */
const ARCHIVES = new Set(['zip', 'rar', '7z']);

/**
 * How deep archives are opened: the upload, and an archive inside it — two
 * invitations hide the Armenian file in a .rar inside a .zip. A third level
 * is not opened; no upload stored has one.
 */
const MAX_DEPTH = 2;

/**
 * A zip entry that is one Office file (.docx, .xlsx…), never an archive of
 * files: `{ office: false }` otherwise; for a .docx, its `$`. Unreadable is
 * `{ office: true, $: null }` — one bad member does not make the others
 * unreadable.
 */
const officeFile = (bytes) => {
  try {
    const zip = new AdmZip(bytes);
    if (!zip.getEntry('[Content_Types].xml')) return { office: false };
    return { office: true, $: wordDocument(zip) };
  } catch {
    return { office: true, $: null };
  }
};

/**
 * Every file in a zip, as `{ path, bytes }`. An entry over the cap is left
 * out rather than refusing the archive, as before archives were nested: a
 * 90 MB scan beside the invitation does not hide the invitation.
 */
const zipFiles = (zip, maxTotalBytes) => {
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory && entry.header.size <= MAX_ENTRY_BYTES);
  const total = entries.reduce((sum, entry) => sum + entry.header.size, 0);
  if (total > maxTotalBytes) throw new Error(`entries declare ${total} bytes, over ${maxTotalBytes}`);
  return entries.map((entry) => ({ path: entry.entryName, bytes: entryData(entry) }));
};

/**
 * Every file in one archive, or null when it cannot be opened — encrypted,
 * corrupt, or declaring more than the caps. `budget` is what the upload as a
 * whole may still unpack to, and is spent here. A failure that is not the
 * file's (the 7-Zip WASM not loading) is thrown, so the job fails and is
 * retried rather than counting the upload `unsupported_format`.
 */
const archiveFiles = async (format, bytes, budget) => {
  let files;
  try {
    files =
      format === 'zip'
        ? zipFiles(new AdmZip(bytes), budget.left)
        : await unpack(bytes, { maxEntryBytes: MAX_ENTRY_BYTES, maxTotalBytes: budget.left });
  } catch (error) {
    if (format !== 'zip' && !(error instanceof ArchiveError)) throw error;
    return null;
  }
  budget.left -= files.reduce((sum, file) => sum + file.bytes.length, 0);
  return budget.left < 0 ? null : files;
};

/**
 * The Word documents in an upload, each handed to `read($, entryName)`: the
 * upload itself when it is a .docx, or every .docx in an archive — a .zip, a
 * .rar or a .7z — and in an archive inside it (`MAX_DEPTH`). What a file is
 * comes from its bytes, never its name: most .rar uploads hold a .docx, and a
 * .docx can be named anything. `entryName` is its path from the upload, an
 * inner archive's path and its own joined by `/`. `format` is what the upload
 * is: `docx` for a Word file, `zip`, `rar` or `7z` for an archive of them,
 * otherwise what `fileFormat` says.
 *
 * Every layer obeys the same per-entry cap, and the upload as a whole
 * `MAX_UNPACKED_BYTES`: an encrypted, corrupt or oversized archive yields no
 * documents, and one unreadable member does not make the others unreadable.
 */
export const wordDocuments = async (bytes, read) => {
  const format = fileFormat(bytes);
  if (!ARCHIVES.has(format)) return { format, documents: [] };

  if (format === 'zip') {
    let zip;
    try {
      zip = new AdmZip(bytes);
    } catch {
      return { format: 'unknown', documents: [] };
    }
    const asWord = wordDocument(zip);
    if (asWord) return { format: 'docx', documents: [read(asWord, null)] };
  }

  const budget = { left: MAX_UNPACKED_BYTES };
  const documents = [];
  const open = async (archiveFormat, archiveBytes, depth, prefix) => {
    const files = await archiveFiles(archiveFormat, archiveBytes, budget);
    for (const file of files ?? []) {
      const name = prefix ? `${prefix}/${file.path}` : file.path;
      const inner = fileFormat(file.bytes);
      const office = inner === 'zip' ? officeFile(file.bytes) : { office: false };
      if (office.office) {
        try {
          if (office.$) documents.push(read(office.$, name));
        } catch {
          // As before archives were nested: one member a parser trips on does not hide the rest.
        }
      } else if (ARCHIVES.has(inner) && depth < MAX_DEPTH) {
        await open(inner, file.bytes, depth + 1, name);
      }
    }
  };
  await open(format, bytes, 1, null);
  return { format, documents };
};

export default { fileFormat, documentText, cellText, armenianPart, isBlank, wordDocuments };
