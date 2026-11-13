import { withTransaction } from '../libs/knex.js';
import tenders from '../repositories/tender.repo.js';
import tenderSources from '../repositories/tenderSource.repo.js';
import FailureService from './failure.service.js';
import { isOpen } from './matcher.service.js';
import { alertsQueue, inferenceQueue } from '../queues/index.js';
import { JOB, PRIORITY, matchJobId, documentsMatchJobId, inferCpvJobId } from '../queues/names.js';
import { logger } from '../utils/logger.js';

/**
 * An addendum: the buyer added, replaced or removed a document after the
 * tender was announced. It is an amendment even when no field Tendra stores
 * moved — an addendum usually changes requirements, and a supplier preparing
 * a bid against the old documents loses the bid (decided 2026-10-20, ticket 18).
 *
 * Whether a document set changed is read off the stored file lists
 * (`tender_documents.manifest`): each file's name, CRC and size. Never the
 * archive's bytes — armeps.am builds its ZIP per download, so its bytes differ
 * every time, and a bytes-only difference is not a new document. e-auction
 * serves a static file, so there the two agree; the same rule serves both.
 */

/** One file's identity: what the buyer published, not where the archive put it. */
const fileKey = (file) => `${file.name}\u0000${Number(file.crc32) >>> 0}\u0000${file.size}`;

const distinct = (names) => [...new Set(names)];

/**
 * Pure: two file lists in, what changed between them out, or null when either
 * list is unknown (an archive that could not be listed) — then there is no
 * telling, and claiming a change would be a guess.
 *
 * A name on both sides with different content is `replaced`, not one file
 * added and another removed.
 */
export const documentChange = (previous, next) => {
  if (!Array.isArray(previous) || !Array.isArray(next)) return null;
  const before = new Map(previous.map((file) => [fileKey(file), file.name]));
  const after = new Map(next.map((file) => [fileKey(file), file.name]));
  const onlyBefore = [...before].filter(([key]) => !after.has(key)).map(([, name]) => name);
  const onlyAfter = [...after].filter(([key]) => !before.has(key)).map(([, name]) => name);
  const replaced = distinct(onlyAfter.filter((name) => onlyBefore.includes(name)));
  return {
    added: distinct(onlyAfter.filter((name) => !replaced.includes(name))),
    replaced,
    removed: distinct(onlyBefore.filter((name) => !replaced.includes(name))),
  };
};

export const isChanged = (change) =>
  Boolean(change && (change.added.length || change.replaced.length || change.removed.length));

/**
 * The amendment alert of one version, through the matcher, which applies the
 * open rule and adds the trackers. Keyed on the version, so a retry and the
 * notification dedupe both absorb a second raise.
 */
const queueAmendment = async ({ tenderId, version, changedFields = [], documentChanges = null }, priority) =>
  alertsQueue.add(
    JOB.MATCH_TENDER,
    { tenderId, event: 'TenderAmended', version, changedFields, ...(documentChanges ? { documentChanges } : {}) },
    { jobId: matchJobId(tenderId, version), priority }
  );

/** `amended` replaces `active` only; a planned tender stays planned. */
const statusAfter = (status, open) => (open && status === 'active' ? 'amended' : status);

export default class AddendumService {
  /**
   * Record a downloaded document set, and if it differs from the one stored
   * before it, raise the addendum: a new `version`, `amended` while the tender
   * is biddable, and the amendment alert through the matcher.
   *
   * `facts` are `tenders.applyInvitationFacts`' input. What it is compared
   * with is the set the tender held before this one — by tender, not by the
   * archive's ref, so a joined replacement's first archive is compared with
   * its predecessor's (ticket 29). With none, this is the tender's first set:
   * its documents, not an addendum.
   *
   * The version moves in the transaction that writes the new document row,
   * and only when that row is new — so a retried job does not count the same
   * addendum twice. A retry after the commit re-queues the alert under the
   * tender's current version, which BullMQ and the notification dedupe both
   * absorb. Two narrow windows are known and accepted: if a field amendment
   * landed between the crash and the retry, the re-queued id is that
   * amendment's and the document alert is lost; and two document jobs for one
   * tender running at once both compare with the same previous set.
   *
   * Every set stored for an open tender also runs the match again, as
   * `TenderIngested` (ticket 25). An e-auction page states no CPV, so its
   * ingest match ran before the archive's codes existed and a CPV-only saved
   * search never saw it. Whether codes were there before is not asked: the
   * notification dedupe makes a match that finds nothing new send nothing, so
   * a retry, a re-download or an ARMEPS set whose codes the page
   * already stated only ever adds. Open is the whole guard against history —
   * what `documents:backfill` and the archive seed store is long closed, while
   * an open tender whose live download failed is exactly the one to catch.
   *
   * `amendment` is a replacement's join (ticket 29), handed over by the
   * normalizer: the version is already raised, so none is raised here, and the
   * one alert goes out with the join's moved fields and this set's file
   * changes together.
   *
   * A set that writes lots asks the tender's failure notices again, in the
   * same transaction (ticket 09): a notice read before the lots existed
   * cancels the tender once they show it named every one. This is the one
   * place a tender's lots are written, for every source.
   */
  static async recordDocuments({ facts, priority = PRIORITY.LIVE, amendment = null }, now = new Date()) {
    const recordSet = async (trx) => {
      const applied = await tenders.applyInvitationFacts(facts, trx);
      if (applied.skipped) return applied;

      const previous = await tenders.findPreviousDocument(applied.tenderId, facts.storageKey, facts.kind, trx);
      if (!previous) return applied;

      const change = documentChange(previous.manifest, facts.manifest);
      if (amendment) return { ...applied, joinChanges: isChanged(change) ? change : null };
      if (!change) {
        logger.warn(
          `[addendum] ${facts.sourceId}: a new document set, but a file list is missing — ` +
            'cannot tell what changed, so no version is raised'
        );
        return applied;
      }
      if (!isChanged(change)) return applied;

      const open = isOpen(applied.tender, now);
      const version = applied.documentRecorded
        ? await tenders.advanceVersion(applied.tenderId, { status: statusAfter(applied.tender.status, open) }, trx)
        : applied.tender.version;
      return { ...applied, addendum: { version, notify: open, documentChanges: change } };
    };

    const result = await withTransaction(async (trx) => {
      const recorded = await recordSet(trx);
      if (recorded.skipped || !recorded.lotsWritten) return recorded;
      return { ...recorded, failure: await FailureService.rederive(recorded.tenderId, trx, now) };
    });

    // Reported where it is made, like a shared supplier ՀՎՀՀ (ticket 11).
    if (result.buyersMerged) {
      logger.info(`[buyers] ${facts.sourceId}: ՀՎՀՀ ${facts.taxId} merged ${result.buyersMerged} buyer(s) into one`);
    }
    if (result.buyersRefused) {
      logger.warn(
        `[buyers] ${facts.sourceId}: ՀՎՀՀ ${facts.taxId} is held by ${result.buyersRefused.length} buyers whose ` +
          'names differ — not merged (npm run buyers:merge -- --confirm): ' +
          result.buyersRefused.map((b) => `${b.source_id} «${b.name}»`).join(', ')
      );
    }

    // The cancellation the lots completed: an amendment like any other, for
    // the matcher's open rule to decide.
    if (result.failure?.event) {
      await alertsQueue.add(
        JOB.MATCH_TENDER,
        { tenderId: result.tenderId, event: result.failure.event, version: result.failure.version, changedFields: result.failure.changedFields },
        { jobId: matchJobId(result.tenderId, result.failure.version), priority }
      );
      logger.info(`[failure] ${facts.sourceId}: its lots complete the failure notices — cancelled v${result.failure.version}`);
    }

    // A `tender-match`, not an amendment: the organizations it adds have never
    // heard of this tender. One already alerted is deduped by
    // `notifications_dedupe_uq`.
    if (!result.skipped && isOpen(result.tender, now)) {
      await alertsQueue.add(
        JOB.MATCH_TENDER,
        { tenderId: result.tenderId, event: 'TenderIngested', version: result.tender.version },
        { jobId: documentsMatchJobId(result.tenderId, facts.storageKey), priority }
      );
    }

    // Lots that state no CPV code get an inferred one (cpv-inference ticket
    // 04, ADR 0006) — only while the tender is biddable, and never for a
    // backfill: a closed tender's guess would feed no alert and no figure, and
    // history is not worth a model call. Queued after the commit, on a lane of
    // its own, so neither this write nor the match above waits on it. Only
    // when this set left a lot to code: an unchanged lot keeps its code (or
    // its recorded attempt) through the rewrite, a renamed one does not.
    if (!result.skipped && result.lotsToCode > 0 && priority !== PRIORITY.BACKFILL && isOpen(result.tender, now)) {
      await inferenceQueue.add(
        JOB.INFER_CPV,
        { tenderId: result.tenderId },
        { jobId: inferCpvJobId(result.tenderId, facts.storageKey), priority }
      );
    }

    if (amendment && !result.skipped) {
      await AddendumService.raiseJoin(amendment, { documentChanges: result.joinChanges ?? null, priority });
      return { ...result, amendmentRaised: true };
    }

    const { addendum } = result;
    if (addendum?.notify) {
      // No field moved, and the alert must not say one did.
      await queueAmendment({ tenderId: result.tenderId, version: addendum.version, documentChanges: addendum.documentChanges }, priority);
    }
    if (addendum) {
      logger.info(`[addendum] ${facts.sourceId} v${addendum.version}${addendum.notify ? '' : ' (not open, no alert)'}`, addendum.documentChanges);
    }
    return result;
  }

  /**
   * Record a paper amendment notice on the tender resolution matched it to
   * (ticket 07): its link, the notice as a document of kind `amendment`, and
   * the addendum it is — a new `version`, `amended` while the tender is open,
   * and the amendment alert naming the notice. Ticket 18's rule, with one
   * difference: a notice is a document beside the invitation, not a set that
   * replaces it, so the change is always the one file added, never a
   * comparison with the set before it.
   *
   * The version moves only when the document row is new, in its transaction,
   * so a notice recorded twice is one addendum. A retry after the commit
   * re-queues the alert under the tender's current version, as
   * `recordDocuments` does, and BullMQ and the notification dedupe absorb it.
   */
  static async recordNotice({ link, facts, fileName, priority = PRIORITY.LIVE }, now = new Date()) {
    const result = await withTransaction(async (trx) => {
      await tenderSources.upsert(link, trx);
      const applied = await tenders.applyInvitationFacts({ ...facts, kind: 'amendment' }, trx);
      if (applied.skipped) return applied;

      const open = isOpen(applied.tender, now);
      const version = applied.documentRecorded
        ? await tenders.advanceVersion(applied.tenderId, { status: statusAfter(applied.tender.status, open) }, trx)
        : applied.tender.version;
      return { ...applied, addendum: { version, notify: open, documentChanges: { added: [fileName], replaced: [], removed: [] } } };
    });

    const { addendum } = result;
    if (addendum?.notify) {
      await queueAmendment({ tenderId: result.tenderId, version: addendum.version, documentChanges: addendum.documentChanges }, priority);
    }
    if (addendum) {
      logger.info(
        `[addendum] ${facts.sourceId} v${addendum.version}: amendment notice ${fileName}` +
          `${addendum.notify ? '' : ' (not open, no alert)'}`
      );
    }
    return result;
  }

  /**
   * The alert of a replacement joining its predecessor's tender (ticket 29):
   * one `TenderAmended` under the join's version, naming the fields that
   * moved and, when the archive was stored and could be compared, the files.
   * The matcher applies the open rule and adds the trackers (ticket 28), as
   * for every amendment. Raised exactly once per version: a second call is
   * absorbed by the job id and the notification dedupe.
   */
  static async raiseJoin({ tenderId, version, changedFields = [] }, { documentChanges = null, priority = PRIORITY.LIVE } = {}) {
    await queueAmendment({ tenderId, version, changedFields, documentChanges }, priority);
    logger.info(`[addendum] tender ${tenderId} v${version}: a replacement joined`, { changedFields, documentChanges });
  }
}
