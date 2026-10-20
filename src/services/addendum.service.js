import { withTransaction } from '../libs/knex.js';
import tenders from '../repositories/tender.repo.js';
import { isOpen } from './matcher.service.js';
import { alertsQueue } from '../queues/index.js';
import { JOB, PRIORITY, matchJobId, documentsMatchJobId } from '../queues/names.js';
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
   */
  static async recordDocuments({ facts, priority = PRIORITY.LIVE, amendment = null }, now = new Date()) {
    const result = await withTransaction(async (trx) => {
      const applied = await tenders.applyInvitationFacts(facts, trx);
      if (applied.skipped) return applied;

      const previous = await tenders.findPreviousDocument(applied.tenderId, facts.storageKey, trx);
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
        ? await tenders.recordAddendum(applied.tenderId, { status: statusAfter(applied.tender.status, open) }, trx)
        : applied.tender.version;
      return { ...applied, addendum: { version, notify: open, documentChanges: change } };
    });

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

    if (amendment && !result.skipped) {
      await AddendumService.raiseJoin(amendment, { documentChanges: result.joinChanges ?? null, priority });
      return { ...result, amendmentRaised: true };
    }

    const { addendum } = result;
    if (addendum?.notify) {
      await alertsQueue.add(
        JOB.MATCH_TENDER,
        {
          tenderId: result.tenderId,
          event: 'TenderAmended',
          version: addendum.version,
          // No field moved, and the alert must not say one did.
          changedFields: [],
          documentChanges: addendum.documentChanges,
        },
        { jobId: matchJobId(result.tenderId, addendum.version), priority }
      );
    }
    if (addendum) {
      logger.info(`[addendum] ${facts.sourceId} v${addendum.version}${addendum.notify ? '' : ' (not open, no alert)'}`, addendum.documentChanges);
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
    await alertsQueue.add(
      JOB.MATCH_TENDER,
      {
        tenderId,
        event: 'TenderAmended',
        version,
        changedFields,
        ...(documentChanges ? { documentChanges } : {}),
      },
      { jobId: matchJobId(tenderId, version), priority }
    );
    logger.info(`[addendum] tender ${tenderId} v${version}: a replacement joined`, { changedFields, documentChanges });
  }
}
