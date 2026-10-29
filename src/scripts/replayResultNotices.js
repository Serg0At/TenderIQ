import { closeDb } from '../libs/knex.js';
import { closeQueues } from '../queues/index.js';
import { JOB, PRIORITY } from '../queues/names.js';
import {
  handlePaperContract,
  handlePaperDocuments,
  handlePaperFailed,
  storedDocumentsJob,
  storedInvitationJobs,
} from '../workers/paper.js';
import { normalizeTender } from '../workers/normalizer.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';
import unmatchedResults from '../repositories/unmatchedResult.repo.js';

/**
 * Read stored gnumner notices again — contract-concluded (ticket 08) and
 * failed-procedure (ticket 09) through their production handlers, as the
 * `retry` job a worker runs (`handlePaperContract`, `handlePaperFailed`,
 * `reason: 'retry'`); paper invitations (ticket 33) through
 * `normalize.tender`, once per notice that uploaded the file, with that
 * notice as its discovery (`storedInvitationJobs`). For a parser or converter
 * that improved: storage is replayed, gnumner is never asked again. Each
 * notice is rebuilt from the listing page stored with it, and resolution
 * decides again, so a notice that still matches nothing stays as it was and
 * one already recorded writes the same rows.
 *
 * Runs the handlers in this process, one notice at a time, and prints what
 * each became; what they queue (an amendment's match, a benchmark) goes to the
 * queues as usual, at backfill priority.
 *
 * Usage:
 *   node src/scripts/replayResultNotices.js [--kind=invitation,contract,failed] [--unmatched=unsupported_format] [--ref=contract:…,…]
 *
 *   --kind       which notices: invitation, contract, failed, or all (default)
 *   --unmatched  only notices left unmatched for this reason and not yet
 *                taken by a tender — e.g. `unsupported_format`, once a
 *                converter can read them
 *   --ref        only these ids (`contract:{digest}`, `failed:{digest}`, an
 *                invitation's content hash)
 */

const SOURCE = 'gnumner';
const INVITATION_ID = /^[0-9a-f]{64}$/;

/**
 * One stored invitation through `normalize.tender`, in this process, a job
 * per notice that uploaded it, then through the document stage
 * (`paper.documents`), which writes its lots through
 * `AddendumService.recordDocuments` — and so asks its failure notices again.
 * Its answer is the last normalize's: the first creates or rejects, and the
 * rest only link their notices. At results priority, not backfill's: the
 * document stage skips backfill for gnumner, and it costs no request.
 *
 * The document stage runs here, not only when the normalize queues it: a
 * normalize queues it for a new file or an event, and a replay whose fields
 * did not move raises none, so the lots a parser fix reads (ticket 36) would
 * never be written. Run twice — here and from a queued job — it writes the
 * same rows.
 */
const replayInvitation = async (job) => {
  const invitationId = job.data.externalRef;
  const jobs = await storedInvitationJobs(invitationId, { priority: PRIORITY.RESULTS });
  if (!jobs.length) return { skipped: 'no_notice_recorded' };
  let result;
  for (const data of jobs) result = await normalizeTender(data);
  if (!result.tenderId) return result;

  const documents = await storedDocumentsJob(invitationId, { priority: PRIORITY.RESULTS });
  if (!documents) return result;
  const stored = await handlePaperDocuments(documents);
  return { ...result, lotsWritten: stored.lotsWritten ?? null, documentsSkipped: stored.skipped ?? null };
};

/** Invitations first: a tender one creates is what a result notice read after it can match. */
const HANDLERS = {
  invitation: { name: JOB.NORMALIZE_TENDER, handle: replayInvitation, prefix: 'detail:' },
  contract: { name: JOB.PAPER_CONTRACT, handle: handlePaperContract, prefix: 'contract:' },
  failed: { name: JOB.PAPER_FAILED, handle: handlePaperFailed, prefix: 'failed:' },
};

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
  })
);
const list = (value) => (typeof value === 'string' ? value.split(',').map((v) => v.trim()).filter(Boolean) : []);

/**
 * The ids of one kind to replay: every one stored, or the unmatched ones of a
 * reason. An invitation's id is its content hash, unprefixed in
 * `unmatched_results` and under `detail:` in storage.
 */
const refsOf = async (kind) => {
  const { prefix } = HANDLERS[kind];
  const invitation = kind === 'invitation';
  if (args.unmatched) {
    const rows = await unmatchedResults.findOpenByReason({
      source: SOURCE,
      refPrefix: invitation ? '' : prefix,
      reason: args.unmatched,
    });
    return rows.map((row) => row.external_ref).filter((ref) => !invitation || INVITATION_ID.test(ref));
  }
  const stored = await sourcePayloads.allByPrefix(SOURCE, prefix);
  return [...new Set(stored.map((row) => (invitation ? row.ref.slice(prefix.length) : row.ref)))].sort();
};

/** What one handler's answer says the notice became, as one label to count. */
const outcomeOf = (result) => {
  if (result.unmatched) return `unmatched ${result.unmatched}`;
  // normalize.tender's answer for one it could not place.
  if (result.skipped === 'unmatched') return `unmatched ${result.reason}`;
  if (result.skipped) return `skipped ${result.skipped}`;
  if (result.resultOnly) return 'result-only tender';
  if (result.event === 'TenderIngested') return 'tender created';
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
        const lots = result.lotsWritten === undefined ? '' : `  lots ${result.lotsWritten ?? `skipped (${result.documentsSkipped})`}`;
        console.log(`${externalRef}  ${outcomeOf(result)}${result.tenderId ? `  ${result.tenderId}` : ''}${lots}`);
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
