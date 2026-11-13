/**
 * A legacy Excel (.xls, BIFF8) reader: the cell values of every sheet, and
 * nothing else — no formats, styles, dates or formulas' formulas.
 *
 * Written for the Ministry of Finance's CPV classifier, which gnumner
 * publishes as BIFF8 (Excel 97–2003) and nothing in the dependency tree reads.
 * Like `archive/zip.js`, it is deliberately small and refuses what it does not
 * handle rather than mis-reading it: an .xlsx, a BIFF5 workbook or an
 * encrypted one is an `XlsError` with a stable `reason`.
 *
 * Two layers. The container is a Compound File (CFB): a FAT-chained sector
 * file holding named streams, of which the workbook is one. The workbook
 * stream is a sequence of BIFF records; cell text lives once in the shared
 * string table (SST), which spills over CONTINUE records, and cells point
 * into it by index.
 *
 * Strings come back exactly as stored. A "compressed" BIFF8 string holds the
 * low byte of each UTF-16 unit, so it decodes as Latin-1 — which is how a
 * legacy Armenian font encoding stored in a Latin-1 cell reaches the caller,
 * untouched, for the caller to transcode.
 */

/** Why a file could not be read. `reason` is stable; callers branch on it. */
export class XlsError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'XlsError';
    this.reason = reason;
  }
}

const corrupt = (message) => new XlsError('corrupt', message);

// ---------------------------------------------------------------- container

const CFB_SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const HEADER_DIFAT_ENTRIES = 109;
const DIR_ENTRY_BYTES = 128;
const DIR_TYPE = { STREAM: 2, ROOT: 5 };

/** The named streams of a Compound File, read on demand. */
const openCompoundFile = (buf) => {
  if (buf.length < 512 || !buf.subarray(0, 8).equals(CFB_SIGNATURE)) {
    // An .xlsx is a zip ("PK"); say so, since that is the likely change.
    const xlsx = buf.subarray(0, 2).toString('latin1') === 'PK';
    throw new XlsError(xlsx ? 'xlsx' : 'not_xls', `not a legacy .xls (Compound File): ${xlsx ? 'an .xlsx' : 'unknown format'}`);
  }

  const sectorShift = buf.readUInt16LE(0x1e);
  const miniShift = buf.readUInt16LE(0x20);
  if (sectorShift !== 9 && sectorShift !== 12) throw corrupt(`sector shift ${sectorShift}`);
  const sectorSize = 1 << sectorShift;
  const miniSize = 1 << miniShift;
  const fatSectorCount = buf.readUInt32LE(0x2c);
  const firstDirSector = buf.readUInt32LE(0x30);
  const miniCutoff = buf.readUInt32LE(0x38);
  const firstMiniFatSector = buf.readUInt32LE(0x3c);
  const firstDifatSector = buf.readUInt32LE(0x44);
  const sectorCount = Math.ceil((buf.length - sectorSize) / sectorSize);

  const sector = (n) => {
    if (n >= sectorCount) throw corrupt(`sector ${n} past the end of the file`);
    return buf.subarray((n + 1) * sectorSize, (n + 2) * sectorSize);
  };
  const words = (s) => Array.from({ length: s.length / 4 }, (_, i) => s.readUInt32LE(i * 4));

  // The FAT's own sectors: 109 named in the header, the rest in a DIFAT chain.
  const fatSectors = words(buf.subarray(0x4c, 0x4c + HEADER_DIFAT_ENTRIES * 4));
  const perDifat = sectorSize / 4 - 1;
  for (let next = firstDifatSector, hops = 0; next !== ENDOFCHAIN && next !== FREESECT; hops += 1) {
    if (hops > sectorCount) throw corrupt('DIFAT chain loops');
    const s = sector(next);
    fatSectors.push(...words(s.subarray(0, perDifat * 4)));
    next = s.readUInt32LE(perDifat * 4);
  }
  const named = fatSectors.filter((n) => n !== FREESECT && n !== ENDOFCHAIN);
  if (named.length < fatSectorCount) throw corrupt('FAT shorter than the header says');
  const fat = named.slice(0, fatSectorCount).flatMap((n) => words(sector(n)));

  /** The sector numbers of a chain, refusing a loop or a dangling link. */
  const chain = (start, table) => {
    const out = [];
    for (let n = start; n !== ENDOFCHAIN; n = table[n]) {
      if (n === FREESECT || n >= table.length || out.length > table.length) throw corrupt(`broken chain at ${n}`);
      out.push(n);
    }
    return out;
  };

  const readRegular = (start, size) => Buffer.concat(chain(start, fat).map(sector)).subarray(0, size);

  const directory = readRegular(firstDirSector, Infinity);
  const entries = [];
  for (let off = 0; off + DIR_ENTRY_BYTES <= directory.length; off += DIR_ENTRY_BYTES) {
    const nameBytes = directory.readUInt16LE(off + 0x40);
    const type = directory[off + 0x42];
    if (!type || nameBytes < 2) continue;
    entries.push({
      name: directory.subarray(off, off + nameBytes - 2).toString('utf16le'),
      type,
      start: directory.readUInt32LE(off + 0x74),
      // The high half is undefined in version-3 files; no stream here nears 4 GB.
      size: directory.readUInt32LE(off + 0x78),
    });
  }
  const root = entries.find((e) => e.type === DIR_TYPE.ROOT);
  if (!root) throw corrupt('no root entry');

  let mini = null;
  const miniStream = () => {
    mini ??= {
      data: readRegular(root.start, root.size),
      fat: chain(firstMiniFatSector, fat).flatMap((n) => words(sector(n))),
    };
    return mini;
  };

  return {
    /** A stream's bytes by name (case-insensitive, as CFB names compare), or null. */
    stream(name) {
      const entry = entries.find((e) => e.type === DIR_TYPE.STREAM && e.name.toLowerCase() === name.toLowerCase());
      if (!entry) return null;
      if (entry.size >= miniCutoff) return readRegular(entry.start, entry.size);
      const { data, fat: miniFat } = miniStream();
      return Buffer.concat(
        chain(entry.start, miniFat).map((n) => data.subarray(n * miniSize, (n + 1) * miniSize))
      ).subarray(0, entry.size);
    },
  };
};

// ----------------------------------------------------------------- workbook

const REC = {
  BOF: 0x0809,
  EOF: 0x000a,
  FILEPASS: 0x002f,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  CONTINUE: 0x003c,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  FORMULA: 0x0006,
  STRING: 0x0207,
};
const BIFF8 = 0x0600;

const recordsOf = (wb) => {
  const out = [];
  for (let pos = 0; pos + 4 <= wb.length; ) {
    const type = wb.readUInt16LE(pos);
    const length = wb.readUInt16LE(pos + 2);
    if (pos + 4 + length > wb.length) throw corrupt(`record 0x${type.toString(16)} runs past the stream`);
    out.push({ type, offset: pos, data: wb.subarray(pos + 4, pos + 4 + length) });
    pos += 4 + length;
  }
  return out;
};

/** BIFF8 RK: a 30-bit integer or the high 30 bits of a double, optionally ×100. */
const decodeRk = (rk) => {
  let value;
  if (rk & 0x02) value = (rk | 0) >> 2;
  else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    value = b.readDoubleLE(0);
  }
  return rk & 0x01 ? value / 100 : value;
};

/** An XLUnicodeString held whole inside one record (LABEL, STRING). */
const unicodeString = (data, pos) => {
  const count = data.readUInt16LE(pos);
  const start = pos + 3;
  return data[pos + 2] & 0x01
    ? data.subarray(start, start + count * 2).toString('utf16le')
    : data.subarray(start, start + count).toString('latin1');
};

/**
 * The shared string table. Its strings run on across CONTINUE records, and a
 * string whose characters are split by a record boundary resumes with one
 * byte giving the encoding of the rest — a boundary between strings, or
 * inside a rich-text run or phonetic block, carries no such byte.
 */
const parseSst = (segments) => {
  const buf = Buffer.concat(segments);
  const ends = [];
  segments.reduce((acc, s) => (ends.push(acc + s.length), acc + s.length), 0);
  const unique = buf.readUInt32LE(4);
  const strings = new Array(unique);
  let pos = 8;
  let seg = 0;

  const chars = (count, highByte) => {
    let high = highByte;
    let out = '';
    for (let left = count; left > 0; ) {
      if (pos === ends[seg]) {
        seg += 1;
        if (seg >= ends.length) throw corrupt('SST string runs past its records');
        high = buf[pos] & 0x01;
        pos += 1;
      }
      const width = high ? 2 : 1;
      const n = Math.min(left, Math.floor((ends[seg] - pos) / width));
      if (n <= 0) throw corrupt('SST character split inside a code unit');
      const bytes = buf.subarray(pos, pos + n * width);
      out += high ? bytes.toString('utf16le') : bytes.toString('latin1');
      pos += n * width;
      left -= n;
    }
    return out;
  };

  for (let i = 0; i < unique; i += 1) {
    while (seg < ends.length && pos >= ends[seg]) seg += 1;
    if (pos + 3 > buf.length) throw corrupt(`SST ends after ${i} of ${unique} strings`);
    const count = buf.readUInt16LE(pos);
    const flags = buf[pos + 2];
    pos += 3;
    const runs = flags & 0x08 ? buf.readUInt16LE(pos) : 0;
    if (flags & 0x08) pos += 2;
    const extBytes = flags & 0x04 ? buf.readInt32LE(pos) : 0;
    if (flags & 0x04) pos += 4;
    strings[i] = chars(count, flags & 0x01);
    pos += runs * 4 + extBytes;
  }
  return strings;
};

/** Index of the EOF record closing the substream that opens at `start`. */
const substreamEnd = (records, start) => {
  let depth = 0;
  for (let i = start; i < records.length; i += 1) {
    if (records[i].type === REC.BOF) depth += 1;
    else if (records[i].type === REC.EOF && (depth -= 1) === 0) return i;
  }
  throw corrupt('substream has no EOF');
};

const readCells = (records, start, end, sst) => {
  const rows = [];
  const put = (r, c, v) => {
    (rows[r] ??= [])[c] = v;
  };
  for (let i = start; i < end; i += 1) {
    const { type, data } = records[i];
    switch (type) {
      case REC.LABELSST: {
        const index = data.readUInt32LE(6);
        if (index >= sst.length) throw corrupt(`string ${index} not in the SST`);
        put(data.readUInt16LE(0), data.readUInt16LE(2), sst[index]);
        break;
      }
      case REC.LABEL:
        put(data.readUInt16LE(0), data.readUInt16LE(2), unicodeString(data, 6));
        break;
      case REC.NUMBER:
        put(data.readUInt16LE(0), data.readUInt16LE(2), data.readDoubleLE(6));
        break;
      case REC.RK:
        put(data.readUInt16LE(0), data.readUInt16LE(2), decodeRk(data.readUInt32LE(6)));
        break;
      case REC.MULRK: {
        const row = data.readUInt16LE(0);
        const first = data.readUInt16LE(2);
        const n = (data.length - 6) / 6;
        for (let k = 0; k < n; k += 1) put(row, first + k, decodeRk(data.readUInt32LE(4 + k * 6 + 2)));
        break;
      }
      case REC.FORMULA: {
        // A cached result: a number, or a string in the STRING record that follows.
        const row = data.readUInt16LE(0);
        const col = data.readUInt16LE(2);
        if (data.readUInt16LE(12) !== 0xffff) put(row, col, data.readDoubleLE(6));
        else if (data[6] === 0 && records[i + 1]?.type === REC.STRING) put(row, col, unicodeString(records[i + 1].data, 0));
        break;
      }
      default:
    }
  }
  return rows;
};

/**
 * Every worksheet of a BIFF8 workbook: `[{ name, rows }]`, in workbook order.
 * `rows[r][c]` is a string, a number, or undefined for an empty cell; a row
 * with no cell is a hole.
 */
export const readXls = (buffer) => {
  const wb = openCompoundFile(buffer).stream('Workbook');
  if (!wb) throw new XlsError('unsupported_version', 'no Workbook stream: not a BIFF8 (Excel 97+) file');

  const records = recordsOf(wb);
  if (records[0]?.type !== REC.BOF || records[0].data.readUInt16LE(0) !== BIFF8) {
    throw new XlsError('unsupported_version', 'workbook is not BIFF8');
  }
  const globalsEnd = substreamEnd(records, 0);

  const sheets = [];
  let sst = [];
  for (let i = 0; i < globalsEnd; i += 1) {
    const { type, data } = records[i];
    if (type === REC.FILEPASS) throw new XlsError('encrypted', 'workbook is encrypted');
    // A worksheet (type 0); chart and macro sheets hold no cells worth reading.
    if (type === REC.BOUNDSHEET && data[5] === 0) {
      const count = data[6];
      const name = data[7] & 0x01
        ? data.subarray(8, 8 + count * 2).toString('utf16le')
        : data.subarray(8, 8 + count).toString('latin1');
      sheets.push({ name, offset: data.readUInt32LE(0) });
    }
    if (type === REC.SST) {
      const segments = [data];
      for (let j = i + 1; records[j]?.type === REC.CONTINUE; j += 1) segments.push(records[j].data);
      sst = parseSst(segments);
    }
  }

  const byOffset = new Map(records.map((r, i) => [r.offset, i]));
  return sheets.map(({ name, offset }) => {
    const start = byOffset.get(offset);
    if (start === undefined || records[start].type !== REC.BOF) throw corrupt(`sheet "${name}" has no BOF at ${offset}`);
    return { name, rows: readCells(records, start, substreamEnd(records, start), sst) };
  });
};

export default { readXls, XlsError };
