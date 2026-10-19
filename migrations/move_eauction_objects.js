// NPM Modules
import crypto from 'crypto';
import knex from 'knex';
import knexConfigs from '../src/configs/knex.config.js';
import redis from '../src/libs/redis.js';
import { getStorage, PREFIX } from '../src/libs/storage/index.js';
import { queues, closeQueues } from '../src/queues/index.js';

/**
 * Ticket 14: every e-auction object moves from the `armeps` storage folders to
 * `eauction`, so that folder = source holds without exception and `armeps` is
 * free for armeps.am. Ticket 01 renamed the source key and left the objects.
 *
 * Run it with the workers STOPPED, after ticket 01's script has run against
 * the same database and bucket.
 *
 * Three phases, each over the whole folder, in this order:
 *
 *   1. copy   — every old object to the same path under `eauction`, verified by
 *               size and by re-reading the copy; where the key carries a content
 *               hash (an .html payload, a .zip archive) the copy must hash to it.
 *   2. rows   — `source_payloads.storage_key` and `tender_documents.storage_key`
 *               move to the new key, only for objects phase 1 verified.
 *   3. delete — an old object goes only once no row names it and its copy is
 *               still there at the same size.
 *
 * Whole-folder phases rather than per-object steps because of the `.txt`
 * sidecar: it has no row, and aiExtractor finds it by swapping `.zip` for
 * `.txt` on the archive's key. Per object, an archive's row could move before
 * its sidecar was copied. A run that dies anywhere leaves every row pointing at
 * an object that exists: rows move only to verified copies, and objects are
 * deleted only after no row points at them.
 *
 * Safe to run twice: a copy that already verifies is not rewritten, rows match
 * only old keys, and a second run finds the old folders empty.
 *
 * Only the storage port is used — get/put, no server-side copy — so it works
 * against both drivers and never imports the AWS SDK.
 */

const OLD = 'armeps';
const NEW = 'eauction';
const FOLDERS = [PREFIX.RAW, PREFIX.TENDER_DOCS];
const TABLES = ['source_payloads', 'tender_documents'];
// Archives are up to 60 MB and each is held in memory with its re-read copy.
const CONCURRENCY = 4;

const CONTENT_TYPES = { html: 'text/html', zip: 'application/zip', txt: 'text/plain; charset=utf-8' };

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const newKeyOf = (key, folder) => `${folder}/${NEW}/${key.slice(`${folder}/${OLD}/`.length)}`;

// An archive and its `.txt` sidecar share everything but the extension, and
// move as one: either both rows-and-deletes happen, or neither.
const stemOf = (key) => key.replace(/\.[^./]+$/, '');

// `{folder}/{source}/{ref}/{hash}.{ext}`. The sidecar's name is the archive's
// hash, not its own, so a `.txt` carries no hash to check against.
const keyHashOf = (key) => {
  const match = key.match(/\/([0-9a-f]{64})\.(html|zip)$/);
  return match ? match[1] : null;
};

// A throw is caught per item, so one bad object cannot reject the pool while
// the other workers still run against a connection about to be destroyed.
const pool = async (items, worker, onError) => {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await worker(item);
      } catch (error) {
        onError(item, error);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, run));
};

const assertWorkersStopped = async () => {
  for (const queue of queues) {
    const workers = await queue.getWorkersCount();
    if (workers > 0) {
      throw new Error(`${workers} worker(s) connected to ${queue.name} — stop the workers first`);
    }
  }
};

const copyFolder = async (storage, folder, counts) => {
  const objects = [];
  for await (const object of storage.list(`${folder}/${OLD}/`)) objects.push(object);
  counts.found = objects.length;

  const copyMatches = async (target, bytes, digest) => {
    const copy = await storage.head(target);
    return copy?.size === bytes.length && sha256(await storage.get(target)) === digest;
  };

  const verified = new Map(); // old key -> new key
  const failedStems = new Set();
  await pool(
    objects,
    async ({ key }) => {
      const target = newKeyOf(key, folder);
      const bytes = await storage.get(key);
      const expected = keyHashOf(key);
      const digest = sha256(bytes);

      if (expected && digest !== expected) {
        counts.corrupt_left_in_place += 1;
        failedStems.add(stemOf(key));
        console.warn(`  ${key}: content hashes to ${digest}, not its key — left in place`);
        return;
      }

      if (await copyMatches(target, bytes, digest)) {
        counts.already_copied += 1;
      } else {
        const head = await storage.head(key);
        const ext = key.split('.').pop();
        await storage.put(target, bytes, {
          contentType: head?.contentType || CONTENT_TYPES[ext] || 'application/octet-stream',
        });
        if (!(await copyMatches(target, bytes, digest))) {
          throw new Error(`copy at ${target} does not verify`);
        }
        counts.copied += 1;
      }
      verified.set(key, target);
    },
    ({ key }, error) => {
      counts.copy_failed += 1;
      failedStems.add(stemOf(key));
      console.warn(`  ${key}: ${error.message} — left in place`);
    }
  );

  // An archive whose sidecar failed, or a sidecar whose archive failed, stays
  // where it is with its partner: aiExtractor reads the `.txt` beside whatever
  // key the row names.
  for (const key of verified.keys()) {
    if (failedStems.has(stemOf(key))) {
      verified.delete(key);
      counts.held_back_with_partner += 1;
    }
  }

  return verified;
};

const moveRows = async (pg, verified, counts) => {
  const pairs = [...verified];
  for (let i = 0; i < pairs.length; i += 500) {
    const batch = pairs.slice(i, i + 500);
    await pg.transaction(async (trx) => {
      // A tender that already names the new key (re-fetched by new code) keeps
      // that row; the old-key row describes the same object and would collide
      // with UNIQUE (tender_id, storage_key).
      const dropped = await trx.raw(
        `DELETE FROM tender_documents AS o
          USING (VALUES ${batch.map(() => '(?, ?)').join(', ')}) AS m(from_key, to_key)
          WHERE o.storage_key = m.from_key
            AND EXISTS (SELECT 1 FROM tender_documents n
                         WHERE n.tender_id = o.tender_id AND n.storage_key = m.to_key)`,
        batch.flat()
      );
      counts.tender_documents_duplicates_dropped += dropped.rowCount;

      for (const table of TABLES) {
        // (from_key, to_key) as a VALUES list, so one statement moves the batch.
        const result = await trx.raw(
          `UPDATE ${table} AS t SET storage_key = m.to_key
             FROM (VALUES ${batch.map(() => '(?, ?)').join(', ')}) AS m(from_key, to_key)
            WHERE t.storage_key = m.from_key`,
          batch.flat()
        );
        counts[`${table}_updated`] += result.rowCount;
      }
    });
  }
};

const deleteOld = async (pg, storage, verified, counts) => {
  await pool([...verified], async ([key, target]) => {
    for (const table of TABLES) {
      if (await pg(table).where({ storage_key: key }).first('storage_key')) {
        counts.still_referenced += 1;
        console.warn(`  ${key}: still named by ${table} — not deleted`);
        return;
      }
    }
    const [source, copy] = await Promise.all([storage.head(key), storage.head(target)]);
    if (!source) {
      counts.already_deleted += 1;
      return;
    }
    if (copy?.size !== source.size) {
      counts.copy_vanished += 1;
      console.warn(`  ${key}: copy at ${target} is gone or changed — not deleted`);
      return;
    }
    await storage.remove(key);
    counts.deleted += 1;
  }, ([key], error) => {
    counts.delete_failed += 1;
    console.warn(`  ${key}: ${error.message} — not deleted`);
  });
};

const moveFolder = async (pg, storage, folder) => {
  const counts = {
    found: 0,
    copied: 0,
    already_copied: 0,
    corrupt_left_in_place: 0,
    copy_failed: 0,
    held_back_with_partner: 0,
    tender_documents_duplicates_dropped: 0,
    source_payloads_updated: 0,
    tender_documents_updated: 0,
    still_referenced: 0,
    copy_vanished: 0,
    already_deleted: 0,
    delete_failed: 0,
    deleted: 0,
  };

  const verified = await copyFolder(storage, folder, counts);
  await moveRows(pg, verified, counts);
  await deleteOld(pg, storage, verified, counts);

  return counts;
};

// What a clean run ends with: nothing left in the old folders, and no row
// naming them — including rows whose object was never in the bucket.
const residue = async (pg, storage) => {
  const left = {};
  for (const folder of FOLDERS) {
    let objects = 0;
    for await (const _ of storage.list(`${folder}/${OLD}/`)) objects += 1;
    left[`${folder}/${OLD}/ objects`] = objects;
    for (const table of TABLES) {
      const [{ count }] = await pg(table).where('storage_key', 'like', `${folder}/${OLD}/%`).count();
      left[`${table} rows naming ${folder}/${OLD}/`] = Number(count);
    }
  }
  return left;
};

async function init() {
  const options =
    process.env.NODE_ENV === 'production' ? knexConfigs.production : knexConfigs.development;
  const pg = knex(options);

  try {
    await assertWorkersStopped();
    const storage = await getStorage();

    for (const folder of FOLDERS) {
      console.log(`${folder}/${OLD}/ -> ${folder}/${NEW}/:`, await moveFolder(pg, storage, folder));
    }

    const left = await residue(pg, storage);
    console.log('left behind:', left);
    if (Object.values(left).some((n) => n > 0)) {
      throw new Error('the old folders are not empty — see the warnings above, fix, and re-run');
    }

    console.log(`✅ Every e-auction object is under "${NEW}".`);
    process.exitCode = 0;
  } catch (error) {
    console.error('❌ Move failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pg.destroy();
    await closeQueues();
    await redis.closeRedis();
  }
}

init();
