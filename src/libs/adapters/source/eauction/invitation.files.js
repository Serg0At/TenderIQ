import { languageOfFilename } from '../../../documentLanguage.js';

/**
 * The invitation archive's entries -> the file list a tender page shows.
 *
 * Every eauction archive is the same few shapes (all 5,671 entries across the
 * 1,087 archives stored on 2026-10-18): `hraver.docx`, `hraver_ru.docx`, then
 * `lot_N_i_texnikakan_bnutagir.*` per lot and `popoxutyan_pastatuxt.*` for an
 * amendment. Nested .zip and .rar entries (846 of them) are listed as files
 * and not opened — the supplier downloads what the buyer published.
 *
 * Language comes from the filename, with one source fact on top: `hraver.docx`
 * carries no marker, yet it IS the Armenian invitation (60 of 60 sampled
 * archives were Armenian text; its `_ru` twin was Russian in all 60). Lot
 * specifications are often bilingual and stay null.
 */
const KNOWN_LANGUAGE = { 'hraver.docx': 'hy' };

const extensionOf = (name) => {
  const match = /\.([^.]+)$/.exec(name);
  return match ? match[1].toLowerCase() : null;
};

/**
 * @param {object[]} entries from libs/adapters/archive/zip.js#listEntries
 * @returns {object[]} the stored manifest: what the page shows (`index`, `path`,
 *   `name`, `ext`, `size`, `language`) plus where the bytes are (`offset`,
 *   `compressedSize`, `method`, `crc32`, `encrypted`), so a download can go
 *   straight to them without re-reading the central directory.
 */
export const invitationManifest = (entries) =>
  entries
    .filter((entry) => !entry.isDirectory)
    .map((entry) => {
      const name = entry.path.split('/').pop();
      return {
        index: entry.index,
        path: entry.path,
        name,
        ext: extensionOf(name),
        size: entry.size,
        language: KNOWN_LANGUAGE[name.toLowerCase()] ?? languageOfFilename(name),
        offset: entry.offset,
        compressedSize: entry.compressedSize,
        method: entry.method,
        crc32: entry.crc32,
        encrypted: entry.encrypted,
      };
    });

export default { invitationManifest };
