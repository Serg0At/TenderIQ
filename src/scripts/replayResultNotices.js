import { closeDb } from '../libs/knex.js';
import { closeQueues } from '../queues/index.js';
import { JOB, PRIORITY } from '../queues/names.js';
import { handlePaperContract, handlePaperFailed } from '../workers/paper.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';
import unmatchedResults from '../repositories/unmatchedResult.repo.js';

/**
 * Read stored gnumner result notices again — contract-concluded (ticket 08)
 * and failed-procedure (ticket 09) — through their production handlers, as
 * the `retry` job a worker runs (`handlePaperContract`, `handlePaperFailed`,
 * `reason: 'retry'`). For a parser that improved: storage is replayed, gnumner
 * is never asked again. Each notice is rebuilt from the listing page stored
 * with it, and resolution decides again, so a notice that still matches
 * nothing stays as it was and one already recorded writes the same rows.
 *
 * Runs the handlers in this process, one notice at a time, and prints what
 * each became; what they queue (an amendment's match, a benchmark) goes to the
 * queues as usual, at backfill priority.
 *
 * Usage:
 *   node src/scripts/replayResultNotices.js [--kind=contract,failed] [--unmatched=unsupported_format] [--ref=contract:…,…]
 *
 *   --kind       which notices: contract, failed, or both (default)
 *   --unmatched  only notices left unmatched for this reason and not yet
 *                taken by a tender — e.g. `unsupported_format`, once a
 *                converter can read them
 *   --ref        only these notice ids (`contract:{digest}`, `failed:{digest}`)
 */

const HANDLERS = {
  contract: { name: JOB.PAPER_CONTRACT, handle: handlePaperContract },
  failed: { name: JOB.PAPER_FAILED, handle: handlePaperFailed },
};
const SOURCE = 'gnumner';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
  })
);
const list = (value) => (typeof value === 'string' ? value.split(',').map((v) => v.trim()).filter(Boolean) : []);

/** The notice ids of one kind to replay: every one stored, or the unmatched ones of a reason. */
const refsOf = async (kind) => {
  const prefix = `${kind}:`;
  if (args.unmatched) {
    const rows = await unmatchedResults.findOpenByReason({ source: SOURCE, refPrefix: prefix, reason: args.unmatched });
    return rows.map((row) => row.external_ref);
  }
  const stored = await sourcePayloads.allByPrefix(SOURCE, prefix);
  return [...new Set(stored.map((row) => row.ref))].sort();
};

/** What one handler's answer says the notice became, as one label to count. */
const outcomeOf = (result) => {
  if (result.unmatched) return `unmatched ${result.unmatched}`;
  if (result.skipped) return `skipped ${result.skipped}`;
  if (result.resultOnly) return 'result-only tender';
  if (result.tenderId) return `linked (${result.status ?? 'status unchanged'})`;
  return 'other';
};

const run = async () => {
  const kinds = list(args.kind).length ? list(args.kind) : Object.keys(HANDLERS);
  const unknown = kinds.filter((kind) => !HANDLERS[kind]);
  if (unknown.length) throw new Error(`--kind takes ${Object.keys(HANDLERS).join(', ')}, not ${unknown.join(', ')}`);
  const only = new Set(list(args.ref));

  const counts = {};
  let failed = 0;
  for (const kind of kinds) {
    const { name, handle } = HANDLERS[kind];
    const refs = (await refsOf(kind)).filter((ref) => !only.size || only.has(ref));
    for (const externalRef of refs) {
      // A stand-in for the BullMQ job: the retry path reads only these.
      const job = { name, data: { source: SOURCE, reason: 'retry', externalRef }, opts: { priority: PRIORITY.BACKFILL } };
      try {
        const result = await handle(job);
        const outcome = `${kind}: ${outcomeOf(result)}`;
        counts[outcome] = (counts[outcome] ?? 0) + 1;
        console.log(`${externalRef}  ${outcomeOf(result)}${result.tenderId ? `  ${result.tenderId}` : ''}`);
      } catch (error) {
        failed += 1;
        console.error(`${externalRef}  FAILED: ${error.message}`);
      }
    }
  }

  console.log(`\n${Object.entries(counts).map(([outcome, n]) => `${n} ${outcome}`).join('\n') || 'nothing to replay'}`);
  if (failed) console.log(`${failed} failed`);
  return failed;
};

run()
  .then(async (failed) => {
    await closeQueues();
    await closeDb();
    process.exit(failed ? 1 : 0);
  })
  .catch(async (error) => {
    console.error(`[notices:replay] ${error.stack ?? error.message}`);
    await closeQueues();
    await closeDb();
    process.exit(1);
  });
