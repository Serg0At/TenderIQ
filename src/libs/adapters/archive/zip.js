import { Readable, Transform, pipeline } from 'stream';
import zlib from 'zlib';
import iconv from 'iconv-lite';

/**
 * A ZIP reader that never needs the whole archive.
 *
 * adm-zip (which the invitation parser uses) wants the archive as one buffer.
 * That is fine in the worker, which has just downloaded it, and wrong in the
 * API: serving one 300 KB .docx out of a 60 MB archive would buffer all 60 MB
 * in the process that answers every other request. A ZIP is built for random
 * access — a central directory at the end lists every entry with its offset —
 * so this reads the tail, then the directory, then exactly one entry's bytes,
 * through a `source` that is either a buffer or ranged reads from storage.
 *
 * Deliberately small: stored (0) and deflate (8) only, no ZIP64, no
 * encryption. Across all 1,087 archives stored on 2026-10-18 (5,671 entries)
 * that is everything: 5,670 deflate, 1 stored, none encrypted, none over 57 MB,
 * no directories. Anything else is refused with a reason, never mis-read.
 *
 * A `source` is `{ size, read(start, end), stream(start, end) }`, `end`
 * inclusive.
 */

const SIG = { EOCD: 0x06054b50, CENTRAL: 0x02014b50, LOCAL: 0x04034b50 };
const EOCD_BYTES = 22;
const LOCAL_HEADER_BYTES = 30;
const MAX_COMMENT = 0xffff;
const UNICODE_PATH_EXTRA = 0x7075;

export const METHOD = { STORED: 0, DEFLATE: 8 };

/** Why an archive or entry could not be read. `reason` is stable; callers branch on it. */
export class ZipError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'ZipError';
    this.reason = reason;
  }
}

const collect = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

/** A source over bytes already in memory — the worker, which has just downloaded them. */
export const bufferSource = (buffer) => ({
  size: buffer.length,
  read: async (start, end) => buffer.subarray(start, end + 1),
  stream: async (start, end) => Readable.from([buffer.subarray(start, end + 1)]),
});

/**
 * A source over a stored object, read by range. Takes the storage port as an
 * argument rather than importing it, so this file stays a pure reader.
 */
export const storageSource = (storage, key, size) => ({
  size,
  read: async (start, end) => collect(await storage.stream(key, { start, end })),
  stream: (start, end) => storage.stream(key, { start, end }),
});

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * An entry name as text.
 *
 * The UTF-8 flag (bit 11) is what the format offers, and many Windows tools
 * never set it: Explorer's built-in zipper writes names in the machine's OEM
 * code page, which on a Russian-locale machine is cp866, and adm-zip then
 * shows Cyrillic as mojibake. So, in order: the flag; the Info-ZIP Unicode
 * Path field (0x7075), honoured only when its CRC matches the raw name it
 * claims to replace; plain ASCII; bytes that happen to be valid UTF-8 (7-Zip
 * and macOS write those without the flag); and only then cp866.
 *
 * Today every armeps entry name is ASCII — the source names files itself —
 * so this is the path for archives that are not yet stored or not yet
 * scraped, not a fix for something observed.
 */
const decodeName = (raw, flags, extra) => {
  if (flags & 0x800) return raw.toString('utf8');

  for (let at = 0; at + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    const body = extra.subarray(at + 4, at + 4 + length);
    if (id === UNICODE_PATH_EXTRA && body.length > 5 && body[0] === 1 && body.readUInt32LE(1) === zlib.crc32(raw)) {
      return body.subarray(5).toString('utf8');
    }
    at += 4 + length;
  }

  if (raw.every((byte) => byte < 0x80)) return raw.toString('latin1');
  try {
    return utf8.decode(raw);
  } catch {
    return iconv.decode(raw, 'cp866');
  }
};

const findEndOfCentralDirectory = (tail) => {
  // Backwards, because the comment after the record may itself contain the
  // signature bytes; the match whose comment length reaches exactly the end
  // of the file is the real one.
  for (let at = tail.length - EOCD_BYTES; at >= 0; at -= 1) {
    if (tail.readUInt32LE(at) !== SIG.EOCD) continue;
    if (at + EOCD_BYTES + tail.readUInt16LE(at + 20) === tail.length) return at;
  }
  throw new ZipError('not_a_zip', 'no end-of-central-directory record');
};

/**
 * Every entry in the archive, in central-directory order. `index` is that
 * position, which is stable because a stored archive never changes.
 */
export const listEntries = async (source) => {
  if (source.size < EOCD_BYTES) throw new ZipError('not_a_zip', `${source.size} bytes is too short for a ZIP`);

  const tailStart = Math.max(0, source.size - EOCD_BYTES - MAX_COMMENT);
  const tail = await source.read(tailStart, source.size - 1);
  const eocd = findEndOfCentralDirectory(tail);

  const disk = tail.readUInt16LE(eocd + 4);
  const count = tail.readUInt16LE(eocd + 10);
  const length = tail.readUInt32LE(eocd + 12);
  const offset = tail.readUInt32LE(eocd + 16);
  if (disk !== 0) throw new ZipError('unsupported', 'multi-disk archive');
  if (count === 0xffff || length === 0xffffffff || offset === 0xffffffff) {
    throw new ZipError('unsupported', 'ZIP64 archive');
  }
  if (count === 0) return [];
  if (offset + length > source.size) throw new ZipError('corrupt', 'central directory runs past the end of the file');

  const directory = await source.read(offset, offset + length - 1);
  const entries = [];
  for (let at = 0, index = 0; index < count; index += 1) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== SIG.CENTRAL) {
      throw new ZipError('corrupt', `central directory entry ${index} is malformed`);
    }
    const flags = directory.readUInt16LE(at + 8);
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    const raw = directory.subarray(at + 46, at + 46 + nameLength);
    const extra = directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    const path = decodeName(raw, flags, extra);

    entries.push({
      index,
      path,
      isDirectory: path.endsWith('/'),
      encrypted: Boolean(flags & 0x1),
      method: directory.readUInt16LE(at + 10),
      crc32: directory.readUInt32LE(at + 16),
      compressedSize: directory.readUInt32LE(at + 20),
      size: directory.readUInt32LE(at + 24),
      offset: directory.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};

/**
 * Holds the inflated bytes to what the central directory promised.
 *
 * The declared size is what the caller checked against its cap and sent as
 * Content-Length, so an entry that inflates past it — a lying header, a
 * decompression bomb — is cut off at that size rather than trusted. A short
 * or corrupted entry fails its CRC at the end.
 */
const verifier = ({ size, crc32 }) => {
  let seen = 0;
  let crc = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      seen += chunk.length;
      if (seen > size) return done(new ZipError('corrupt', `entry inflates past its declared ${size} bytes`));
      crc = zlib.crc32(chunk, crc);
      return done(null, chunk);
    },
    flush(done) {
      if (seen !== size) return done(new ZipError('corrupt', `entry inflated to ${seen} bytes, declared ${size}`));
      if (crc >>> 0 !== crc32 >>> 0) return done(new ZipError('corrupt', 'entry failed its CRC check'));
      return done();
    },
  });
};

/**
 * One entry's content as a stream.
 *
 * Refuses before reading any data if the entry cannot be served or declares
 * more than `maxBytes`. The local header is read for its own name and extra
 * lengths, which may differ from the central directory's copy.
 */
export const openEntry = async (source, entry, { maxBytes }) => {
  if (entry.isDirectory) throw new ZipError('unsupported', 'entry is a directory');
  if (entry.encrypted) throw new ZipError('unsupported', 'entry is encrypted');
  if (entry.method !== METHOD.STORED && entry.method !== METHOD.DEFLATE) {
    throw new ZipError('unsupported', `compression method ${entry.method}`);
  }
  if (entry.size > maxBytes) throw new ZipError('too_large', `entry declares ${entry.size} bytes, over ${maxBytes}`);

  const header = await source.read(entry.offset, entry.offset + LOCAL_HEADER_BYTES - 1);
  if (header.length < LOCAL_HEADER_BYTES || header.readUInt32LE(0) !== SIG.LOCAL) {
    throw new ZipError('corrupt', `no local header at offset ${entry.offset}`);
  }
  const dataStart = entry.offset + LOCAL_HEADER_BYTES + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (dataStart + entry.compressedSize > source.size) throw new ZipError('corrupt', 'entry runs past the end of the file');

  const stages = [];
  if (entry.compressedSize > 0) stages.push(await source.stream(dataStart, dataStart + entry.compressedSize - 1));
  else stages.push(Readable.from([]));
  if (entry.method === METHOD.DEFLATE) stages.push(zlib.createInflateRaw());
  const out = verifier(entry);
  stages.push(out);

  // pipeline() destroys every stage if any one fails or the consumer goes
  // away, which is what releases the storage connection on a client abort.
  pipeline(...stages, () => {});
  return out;
};

export default { ZipError, METHOD, bufferSource, storageSource, listEntries, openEntry };
