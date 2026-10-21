import AdmZip from 'adm-zip';

/**
 * A paper invitation as the archive a tender's documents are served from.
 *
 * Every tender document is a ZIP the API lists once and streams one entry out
 * of (services/tenderDocument.service.js). An uploaded .zip already is one. A
 * bare .docx is a ZIP too, but of Word's own parts, so it is wrapped in a
 * one-entry archive under the name it was uploaded as — and from there the
 * manifest, the download and the addendum check are e-auction's and armeps.am's
 * unchanged.
 *
 * The wrapper's bytes carry the time it was built, so its identity is the
 * upload's content hash (in the storage key), never the wrapper's own bytes.
 */

/**
 * The file's name as the buyer uploaded it, out of the URL path. gnumner keeps
 * the original name with every non-ASCII character blanked, so a name can be
 * mostly spaces ("  26 11.docx"); those runs are collapsed, and a name with
 * nothing left gets a plain one.
 */
export const uploadedName = (url, fallback = 'invitation.docx') => {
  let name = '';
  try {
    name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  } catch {
    name = '';
  }
  name = name.replace(/\s+/g, ' ').trim();
  return /^[^.]+\..+$/.test(name) && !/^[\s._-]*\./.test(name) ? name : fallback;
};

/**
 * Whether a ZIP is an Office file (.docx, .xlsx…) rather than an archive of
 * files: Office Open XML packages carry `[Content_Types].xml`. Only its
 * packaging is looked at, never its text. An Office file is wrapped as one
 * entry, or the tender page would list its XML parts as documents.
 */
export const isOfficeFile = (bytes) => {
  try {
    return Boolean(new AdmZip(bytes).getEntry('[Content_Types].xml'));
  } catch {
    return false;
  }
};

/** `format` is invitation.parser.js's: `docx` is wrapped, `zip` is stored as it is. */
export const invitationArchive = (bytes, { format, fileName }) => {
  if (format === 'zip') return bytes;
  const archive = new AdmZip();
  archive.addFile(fileName, bytes);
  return archive.toBuffer();
};

export default { uploadedName, invitationArchive, isOfficeFile };
