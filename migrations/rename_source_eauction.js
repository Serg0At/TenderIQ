// NPM Modules
import knex from 'knex';
import knexConfigs from '../src/configs/knex.config.js';
import redis from '../src/libs/redis.js';
import { ingestFetchQueue, ingestNormalizeQueue, ingestBackfillQueue, closeQueues } from '../src/queues/index.js';

/**
 * ADR 0004: the e-auction source key `armeps` becomes `eauction`, so that
 * `armeps` can later mean armeps.am without one name meaning two websites.
 *
 * Not additive — it rewrites data — but safe to run twice: every statement matches only rows, keys and
 * jobs still carrying the old name, so a second run changes nothing and says so.
 *
 * Run it with the workers STOPPED, after the new code is deployed and before
 * `npm run scheduler`:
 *
 *   stop workers -> deploy -> node migrations/rename_source_eauction.js
 *                -> npm run scheduler -> start workers
 *
 * A worker on the old code would fail every job this script migrates, and one
 * on the new code would fail every job it has not migrated yet, so the Redis
 * half refuses to run while any ingest worker is connected.
 *
 * Stored objects are NOT moved. `source_payloads.storage_key` keeps pointing at
 * `raw/armeps/...`, which is what keeps replay working; new payloads are written
 * under `raw/eauction/`.
 */

const OLD = 'armeps';
const NEW = 'eauction';

const PREFIXED = ['tenders', 'parties']; // source_id = '<source>:...'
const LEDGER = ['awards', 'public_tender_bids', 'tender_lots']; // source column, default OLD

const renameDatabase = async (trx) => {
  const counts = {};

  for (const table of PREFIXED) {
    counts[`${table}.source_id`] = await trx(table)
      .where('source_id', 'like', `${OLD}:%`)
      .update({ source_id: trx.raw('? || substr(source_id, ?)', [`${NEW}:`, OLD.length + 2]) });
  }

  // A payload already recorded under the new name is the same (ref, hash) the
  // old row describes — same content, written by new code that ran early. The
  // old row is then a duplicate, and renaming it would hit the unique key.
  counts['source_payloads.duplicates_dropped'] = await trx('source_payloads as o')
    .where('o.source', OLD)
    .whereExists(
      trx('source_payloads as n')
        .where('n.source', NEW)
        .whereRaw('n.ref = o.ref and n.hash = o.hash')
    )
    .del();
  counts['source_payloads.source'] = await trx('source_payloads')
    .where('source', OLD)
    .update({ source: NEW });

  for (const table of LEDGER) {
    // The ledger is replaced per (tender, source), so a tender holding rows
    // under both names had a writer on the new code before this ran. Which set
    // is current is not this script's call — stop and let a human look.
    const both = await trx(table)
      .select('tender_id')
      .whereIn('source', [OLD, NEW])
      .groupBy('tender_id')
      .havingRaw('count(distinct source) > 1')
      .limit(5);
    if (both.length) {
      throw new Error(
        `${table} holds rows under both "${OLD}" and "${NEW}" for tender(s) ` +
          `${both.map((r) => r.tender_id).join(', ')} — resolve by hand, then re-run`
      );
    }

    counts[`${table}.source`] = await trx(table).where('source', OLD).update({ source: NEW });
    await trx.raw(`ALTER TABLE ${table} ALTER COLUMN source SET DEFAULT '${NEW}'`);
  }

  return counts;
};

/** Carry a numeric key over, keeping the larger value and the old TTL. */
const carryMax = async (client, from, to) => {
  const old = await client.get(from);
  if (old === null) return false;
  const current = await client.get(to);
  if (current === null || Number(old) > Number(current)) {
    const ttl = await client.pttl(from);
    if (ttl > 0) await client.set(to, old, 'PX', ttl);
    else await client.set(to, old);
  }
  await client.del(from);
  return true;
};

/** Carry a key over only if the new one does not exist yet. */
const carryIfAbsent = async (client, from, to) => {
  if ((await client.exists(from)) === 0) return false;
  if ((await client.exists(to)) === 0) await client.rename(from, to);
  else await client.del(from);
  return true;
};

const scan = async (client, pattern) => {
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
};

const PENDING = ['waiting', 'delayed', 'prioritized', 'paused', 'waiting-children'];

/**
 * Re-add every pending job of the old source under the new one, then remove
 * the original. Add-then-remove, so a crash in between leaves a duplicate
 * rather than a lost job: an explicit jobId dedupes on the re-run, and the
 * auto-id listing pages are idempotent by design.
 */
const migrateJobs = async (queue) => {
  let moved = 0;
  let kept = 0;
  const now = Date.now();
  for (const job of await queue.getJobs(PENDING)) {
    if (!job || job.data?.source !== OLD) continue;
    if (String(job.id).startsWith('repeat:')) continue; // owned by its scheduler, removed with it

    const { jobId, repeat, repeatJobKey, delay, ...opts } = job.opts;
    // A custom id that does not carry the source cannot be re-added beside the
    // original (the add would dedupe onto it), and dropping it would lose the
    // dedupe it exists for. Every producer today prefixes the source, so this
    // is a guard, not a path: report it and leave the job for a human.
    if (jobId && !jobId.startsWith(`${OLD}-`)) {
      kept += 1;
      continue;
    }
    const remaining = Math.max(0, job.timestamp + (job.delay ?? 0) - now);
    await queue.add(
      job.name,
      { ...job.data, source: NEW },
      {
        ...opts,
        ...(jobId ? { jobId: `${NEW}-${jobId.slice(OLD.length + 1)}` } : {}),
        ...(remaining > 0 ? { delay: remaining } : {}),
      }
    );
    await job.remove();
    moved += 1;
  }
  return {
    [`jobs ${queue.name}`]: moved,
    ...(kept ? { [`jobs ${queue.name} with a custom id (left in place)`]: kept } : {}),
  };
};

const QUEUES = [ingestFetchQueue, ingestNormalizeQueue, ingestBackfillQueue];

/**
 * Checked before the database is touched, not just before Redis: a live worker
 * would start writing new-key rows beside the renamed ones the moment the
 * transaction commits, or old-key ones if it is still on the old code.
 */
const assertWorkersStopped = async () => {
  for (const queue of QUEUES) {
    const workers = await queue.getWorkersCount();
    if (workers > 0) {
      throw new Error(`${workers} worker(s) connected to ${queue.name} — stop the workers first`);
    }
    const active = (await queue.getJobs(['active'])).filter((j) => j?.data?.source === OLD);
    if (active.length) {
      throw new Error(`${active.length} active ${OLD} job(s) on ${queue.name} — let them finish first`);
    }
  }
};

const renameRedis = async () => {
  const client = redis.getRedis();
  const counts = {};

  counts['sweep:ok'] = await carryMax(client, `sweep:ok:${OLD}`, `sweep:ok:${NEW}`);

  const watermarks = await scan(client, `sweep:tid:${OLD}:*`);
  for (const key of watermarks) {
    await carryMax(client, key, `sweep:tid:${NEW}:${key.slice(`sweep:tid:${OLD}:`.length)}`);
  }
  counts['sweep:tid'] = watermarks.length;

  const progress = await scan(client, `backfill:${OLD}:*`);
  for (const key of progress) {
    await carryIfAbsent(client, key, `backfill:${NEW}:${key.slice(`backfill:${OLD}:`.length)}`);
  }
  counts['backfill progress'] = progress.length;

  // Removing the old schedulers also removes their next delayed run. The new
  // ones are created by `npm run scheduler`, which derives their id from the key.
  counts.schedulers = 0;
  for (const id of [`sweep-${OLD}`, `refresh-${OLD}`]) {
    if (await ingestFetchQueue.removeJobScheduler(id)) counts.schedulers += 1;
  }

  for (const queue of QUEUES) Object.assign(counts, await migrateJobs(queue));

  // Dead letters are left as they are: they are the record of what failed and
  // why, and a retry of one would now fail on the unknown source. Reported so
  // nobody mistakes them for live work.
  for (const queue of QUEUES) {
    const failed = (await queue.getJobs(['failed'])).filter((j) => j?.data?.source === OLD).length;
    if (failed) counts[`failed ${queue.name} (left in place)`] = failed;
  }

  return counts;
};

async function init() {
  const options =
    process.env.NODE_ENV === 'production' ? knexConfigs.production : knexConfigs.development;
  const pg = knex(options);

  try {
    await assertWorkersStopped();

    const db = await pg.transaction(renameDatabase);
    console.log('database:', db);

    const kv = await renameRedis();
    console.log('redis:', kv);

    console.log(`✅ Source key "${OLD}" renamed to "${NEW}". Next: npm run scheduler`);
    process.exitCode = 0;
  } catch (error) {
    console.error('❌ Rename failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pg.destroy();
    await closeQueues();
    await redis.closeRedis();
  }
}

init();
