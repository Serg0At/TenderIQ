import SevenZip from '7z-wasm';

/**
 * Every file in a .rar or .7z archive, read in memory by 7-Zip compiled to
 * WASM (7z-wasm), so the worker image gains no system binary.
 *
 * One library for both formats: 7-Zip carries the unRAR decoder, and on the
 * 12 .rar and 2 .7z uploads gnumner held on 2026-10-28 it read RAR4, RAR5
 * and 7z with compressed headers alike, in about 10 ms each. This file is the
 * only one that imports it.
 *
 * Nothing is extracted before the listing has been checked: an encrypted
 * entry is refused, and so is any entry, or the archive as a whole, that
 * declares more than the caller allows — an archive bomb is ordinary input
 * from an untrusted upload. What 7-Zip then writes is measured again, so a
 * header that lied is refused too, if only after the fact.
 *
 * Anything but an `ArchiveError` — the WASM failing to load, say — is not a
 * property of the file and is thrown as it is, so a broken install fails the
 * job instead of counting every archive as unreadable.
 *
 * Each call gets an instance of its own. 7-Zip's in-memory file system is
 * per instance, and an archive whose headers are encrypted makes 7-Zip throw
 * a C++ exception out of WASM that leaves the instance unusable — so nothing
 * is ever reused, and a throw is a refusal like any other.
 */

/** Why an archive could not be read. `reason` is stable; callers branch on it. */
export class ArchiveError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'ArchiveError';
    this.reason = reason;
  }
}

const IN = '/in';
const OUT = '/out';

/**
 * Never empty: with no password 7-Zip asks for one on stdin when a header is
 * encrypted. With a wrong one it fails, which is what an encrypted upload is
 * to us — nobody is going to type a password into a worker.
 */
const NO_PASSWORD = '-pnone';

const run = async (bytes, args) => {
  const lines = [];
  const sevenZip = await SevenZip({ print: (line) => lines.push(line), printErr: (line) => lines.push(line) });
  sevenZip.FS.writeFile(IN, bytes);
  // Emscripten's exit hook writes 7-Zip's status into `process.exitCode`,
  // which would make a worker that once met a corrupt archive exit 2.
  const exitCode = process.exitCode;
  let code;
  try {
    code = sevenZip.callMain([...args, NO_PASSWORD, '-bd', '-sccUTF-8', IN]);
  } catch {
    throw new ArchiveError('unreadable', '7-Zip could not open the archive (encrypted headers, or corrupt)');
  } finally {
    process.exitCode = exitCode;
  }
  if (code !== 0) {
    const said = lines.filter((line) => /error|wrong password/i.test(line)).join('; ');
    throw new ArchiveError(/wrong password|encrypted/i.test(said) ? 'encrypted' : 'corrupt', said || `7-Zip exited ${code}`);
  }
  return { sevenZip, lines };
};

/**
 * `l -slt`: a block of `Key = value` lines per entry, after a `----------`
 * line that ends the archive's own block.
 */
const parseListing = (lines) => {
  const at = lines.indexOf('----------');
  if (at < 0) throw new ArchiveError('corrupt', '7-Zip listed no entries');
  const entries = [];
  let entry = null;
  for (const line of lines.slice(at + 1)) {
    const field = line.match(/^(\w[\w ]*?) = (.*)$/);
    if (!field) {
      entry = null;
      continue;
    }
    if (!entry) entries.push((entry = {}));
    entry[field[1]] = field[2];
  }
  return entries.map((e) => ({
    path: e.Path,
    isDirectory: e.Folder === '+' || /^D/.test(e.Attributes ?? ''),
    encrypted: e.Encrypted === '+',
    size: Number(e.Size ?? 0),
  }));
};

const walk = (fs, dir, prefix = '') =>
  fs.readdir(dir).flatMap((name) => {
    if (name === '.' || name === '..') return [];
    const full = `${dir}/${name}`;
    const path = prefix ? `${prefix}/${name}` : name;
    return fs.isDir(fs.stat(full).mode) ? walk(fs, full, path) : [{ path, bytes: Buffer.from(fs.readFile(full)) }];
  });

/**
 * Every file in the archive `bytes`, as `{ path, bytes }`, directories left
 * out. Throws `ArchiveError` — `encrypted`, `too_large`, `corrupt` or
 * `unreadable` — rather than return a part of it.
 */
export const unpack = async (bytes, { maxEntryBytes, maxTotalBytes }) => {
  const listed = parseListing((await run(bytes, ['l', '-slt'])).lines).filter((e) => !e.isDirectory);

  const encrypted = listed.find((e) => e.encrypted);
  if (encrypted) throw new ArchiveError('encrypted', `${encrypted.path} is encrypted`);
  const large = listed.find((e) => e.size > maxEntryBytes);
  if (large) throw new ArchiveError('too_large', `${large.path} declares ${large.size} bytes, over ${maxEntryBytes}`);
  const total = listed.reduce((sum, e) => sum + e.size, 0);
  if (total > maxTotalBytes) throw new ArchiveError('too_large', `entries declare ${total} bytes, over ${maxTotalBytes}`);

  const { sevenZip } = await run(bytes, ['x', '-y', `-o${OUT}`]);
  const files = walk(sevenZip.FS, OUT);
  const written = files.reduce((sum, f) => sum + f.bytes.length, 0);
  if (files.some((f) => f.bytes.length > maxEntryBytes) || written > maxTotalBytes) {
    throw new ArchiveError('too_large', `entries unpacked to ${written} bytes, past what their headers declared`);
  }
  return files;
};

export default { ArchiveError, unpack };
