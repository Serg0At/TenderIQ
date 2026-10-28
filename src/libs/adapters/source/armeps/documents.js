import * as cheerio from 'cheerio';
import { languageOfFilename } from '../../../documentLanguage.js';
import { sha256 } from '../../../../utils/hash.js';
import { agreedTaxId, beneficiaryTaxIds } from '../../../taxId.js';
import { documentText, wordDocuments } from '../gnumner/word.js';

/**
 * Pure: an armeps.am contract-documents ZIP's entries (and the CfT page's
 * document table) in, plain objects out. No network, no database, no clock.
 *
 * The ZIP is `downloadCftResourceItems.do?resourceId=N&resourceType=
 * ContractDocument`, the page's "Download Zip file". Verified on 2026-10-20
 * against 12315509, 12542029 and 12543933, it holds:
 *
 *   1_c4t_12315509_1.xml          the "Tender Structure XML": envelopes and lots
 *   2_Invitation (10).doc         every file the buyer uploaded, numbered
 *   …
 *   1390_12315509.pdf             a "List of Contract Documents" e-PPS renders
 *                                 at download time ({authority id}_{resourceId})
 *
 * The archive is built on request, so its bytes are never the same twice: the
 * entry timestamps are the download time, and the listing PDF carries its own
 * creation date. The buyer's files are unchanged (same CRC) between downloads.
 */

const generatedListing = (resourceId) => new RegExp(`^\\d+_${resourceId}\\.pdf$`);

/** "2_Invitation (10).doc" -> "Invitation (10).doc": the numbering is the ZIP's, not the buyer's. */
const uploadedName = (path) => path.split('/').pop().replace(/^\d+_/, '');

const extensionOf = (name) => {
  const match = /\.([^.]+)$/.exec(name);
  return match ? match[1].toLowerCase() : null;
};

/** The entries the buyer published: everything but directories and the generated listing. */
const published = (entries, resourceId) => {
  const listing = generatedListing(resourceId);
  return entries.filter((entry) => !entry.isDirectory && !listing.test(entry.path));
};

/**
 * What identifies one set of documents: every published entry's path, CRC and
 * size — not the archive's bytes, which differ on every download. Two
 * downloads of the same set hash the same, and a new or re-uploaded file
 * changes it. Used as the content hash in the storage key and in
 * `source_payloads`, so a re-download of an unchanged set writes nothing.
 */
export const documentSetHash = (entries, resourceId) =>
  sha256(
    JSON.stringify(
      published(entries, resourceId)
        .map((entry) => [entry.path, entry.crc32 >>> 0, entry.size])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    )
  );

/**
 * The file list a tender page shows, in the shape `tender_documents.manifest`
 * stores (see eauction/invitation.files.js; the schema is shared).
 *
 * The language is the one the CfT page's table states for that file name
 * (HY/EN/RU), which is the buyer's own tag rather than a guess from the name.
 * When two files share a name with different languages — 12542029 uploads
 * the EN and RU announcements under one name — the name cannot say which is
 * which, so it falls back to the filename's own marker, usually null.
 */
export const documentManifest = (entries, { resourceId, pageDocuments = [] }) => {
  // Compared with whitespace collapsed: the page's text does that, and the
  // ZIP keeps the buyer's double spaces ("…-27-7.2  25-+.doc").
  const key = (name) => String(name).replace(/\s+/g, ' ').trim();
  const languages = new Map();
  for (const { fileName, language } of pageDocuments) {
    if (!fileName) continue;
    const seen = languages.get(key(fileName));
    languages.set(key(fileName), seen === undefined || seen === language ? language : null);
  }

  return published(entries, resourceId).map((entry) => {
    const name = uploadedName(entry.path);
    const stated = languages.get(key(name));
    return {
      index: entry.index,
      path: entry.path,
      name,
      ext: extensionOf(name),
      size: entry.size,
      language: stated ?? languageOfFilename(name),
      offset: entry.offset,
      compressedSize: entry.compressedSize,
      method: entry.method,
      crc32: entry.crc32,
      encrypted: entry.encrypted,
    };
  });
};

/**
 * The Tender Structure XML entry to read, `{n}_c4t_{resourceId}_{cycle}.xml`.
 * A later cycle supersedes an earlier one, so the highest wins.
 */
export const tenderStructureEntry = (entries, resourceId) => {
  const pattern = new RegExp(`(?:^|/)(?:\\d+_)?c4t_${resourceId}_(\\d+)\\.xml$`);
  return (
    entries
      .map((entry) => ({ entry, cycle: Number(entry.path.match(pattern)?.[1]) }))
      .filter(({ cycle }) => Number.isFinite(cycle))
      .sort((a, b) => b.cycle - a.cycle)[0]?.entry ?? null
  );
};

/**
 * `<c4t num-of-lots="2" …><lot id="1"><title>[1] name</title>…</lot>…</c4t>`
 * -> its lots. A tender bought as one contract has `num-of-lots="0"` and no
 * `<lot>`, and yields none: there is no lot to name, and inventing "lot 1"
 * would be a row the source never published.
 */
export const parseTenderStructure = (xml) => {
  const $ = cheerio.load(xml, { xmlMode: true });
  const $root = $('c4t').first();
  if (!$root.length) return null;

  const lots = [];
  $root.children('lot').each((_, lot) => {
    const lotNumber = Number($(lot).attr('id'));
    if (!Number.isInteger(lotNumber) || lotNumber < 1) return;
    const title = $(lot).children('title').first().text().replace(/\s+/g, ' ').trim();
    lots.push({ lotNumber, name: title.replace(/^\[\d+\]\s*/, '') || null });
  });

  const declared = Number($root.attr('num-of-lots'));
  return { declaredLots: Number.isFinite(declared) ? declared : null, lots };
};

/**
 * Which CPV each lot is in. The CfT page lists the tender's CPV codes but not
 * which lot is which, so only two readings are taken: one code covers every
 * lot; otherwise a lot whose name begins with exactly one code's label — e-PPS
 * titles a lot after its CPV ("[1] ռետինափողրակներ /…/" under "44163300-
 * ռետինափողրակներ") — takes that code. Anything else stays null rather than
 * put a lot in a category the buyer did not.
 */
export const cpvForLots = (lots, cpv = []) =>
  lots.map((lot) => {
    if (cpv.length === 1) return { ...lot, cpvCode: cpv[0].code };
    const name = String(lot.name ?? '').toLowerCase();
    const fits = cpv.filter(({ label }) => label && name.startsWith(label.toLowerCase()));
    return { ...lot, cpvCode: fits.length === 1 ? fits[0].code : null };
  });

/**
 * The entries the buyer's ՀՎՀՀ is read from (ticket 19): every published
 * .docx, and every .zip, whose .docx one level down are read too.
 *
 * Only Word's XML format. A set's invitation is as often an old .doc or a
 * .pdf, and neither has a reader here (the gnumner parsers' format check says
 * the same): of the first 54 sets, the .docx gave 34 a ՀՎՀՀ — 21 of 32
 * buyers — and a .doc or .pdf reader would have added 9 sets and 2 buyers.
 * Added later, it replays from storage with `npm run buyers:merge`.
 */
export const taxIdEntries = (entries, resourceId) =>
  published(entries, resourceId).filter((entry) => /\.(docx|zip)$/i.test(entry.path));

/**
 * The buyer's ՀՎՀՀ: the guarantee form's beneficiary (libs/taxId.js), on
 * which every Word document of the set agrees, or null.
 */
export const buyerTaxIdOf = (files) =>
  agreedTaxId(files.flatMap((bytes) => wordDocuments(bytes, ($) => beneficiaryTaxIds(documentText($))).documents.flat()));

export default {
  documentSetHash,
  documentManifest,
  tenderStructureEntry,
  parseTenderStructure,
  cpvForLots,
  taxIdEntries,
  buyerTaxIdOf,
};
