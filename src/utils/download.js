/**
 * Response headers for handing a file to a browser.
 */

/** By extension, for the formats tender archives actually contain; anything else is opaque bytes. */
const CONTENT_TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xml: 'application/xml',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  txt: 'text/plain; charset=utf-8',
};

export const contentTypeOf = (ext) => CONTENT_TYPES[String(ext ?? '').toLowerCase()] ?? 'application/octet-stream';

/** RFC 5987 value-chars: encodeURIComponent leaves `'()*` bare, and those are not attr-chars. */
const encodeRfc5987 = (value) =>
  encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * `attachment` with the real name in `filename*` (RFC 6266 / 5987), which every
 * current browser prefers, and an ASCII stand-in in `filename` for anything
 * that does not read it. Without `filename*`, an Armenian or Russian name
 * arrives as mojibake or as the route's last path segment — `3`.
 *
 * Always `attachment`, never `inline`: these are files a buyer published, and
 * rendering one in our origin is not something to offer.
 */
export const contentDisposition = (filename) => {
  const fallback = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
};

export default { contentTypeOf, contentDisposition };
