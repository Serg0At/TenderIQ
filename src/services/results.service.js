import tenders from '../repositories/tender.repo.js';
import unmatchedResults from '../repositories/unmatchedResult.repo.js';
import { deriveStatus } from './resolution.service.js';
import { alertsQueue, maintenanceQueue } from '../queues/index.js';
import { JOB, PRIORITY, matchJobId } from '../queues/names.js';

/**
 * A results source's word on a tender resolution matched it to: a gnumner
 * contract notice on a paper tender (ticket 08), a PPCM procedure on an
 * ARMEPS one (ticket 10). One path for both, so "a result landed" means the
 * same thing whichever source said it.
 */
export default class ResultsService {
  /**
   * Write the observation's ledger on `decision.tender` and move its status.
   *
   * The status is the source's word through the owners table (`deriveStatus`,
   * ADR 0004): it counts only where that source owns the channel's award.
   * `tenders.recordResults` writes link, bids, awards and status in one
   * transaction under the row lock, and throws if the tender moved since it
   * was resolved, so the retry decides again.
   *
   * After the commit: an unmatched row of the same result is resolved (only
   * when the link is new — one already linked was never unmatched since); a
   * status that moved goes to the matcher like an e-auction settling, whose
   * open rule decides whether anyone is told; and awards that landed queue a
   * benchmark recompute, keyed by `benchmarkKey` so the same result read
   * again queues nothing new — except on a result-only tender (ticket 31),
   * which has no CPV for a benchmark to be keyed by.
   */
  static async record({ observation, decision, link, benchmarkKey, priority = PRIORITY.LIVE }, now = new Date()) {
    const status = deriveStatus(
      {
        submissionChannel: observation.submissionChannel,
        links: [{ source: link.source, status: observation.status }],
        current: decision.tender.status,
        deadlineAt: decision.tender.deadlineAt,
      },
      now
    );
    const result = await tenders.recordResults({
      tenderId: decision.tenderId,
      expectedStatus: decision.tender.status,
      status,
      link,
      lots: observation.ledger,
    });

    if (decision.rule !== 'link') {
      await unmatchedResults.markResolved({ source: link.source, externalRef: link.externalId, tenderId: decision.tenderId });
    }
    if (result.event) {
      await alertsQueue.add(
        JOB.MATCH_TENDER,
        { tenderId: result.tenderId, event: result.event, version: result.version, changedFields: result.changedFields },
        { jobId: matchJobId(result.tenderId, result.version), priority }
      );
    }
    if (result.awards > 0 && !decision.tender.resultOnly) {
      await maintenanceQueue.add(
        JOB.RECOMPUTE_BENCHMARKS,
        { tenderId: result.tenderId },
        { jobId: `benchmarks-${result.tenderId}-${benchmarkKey}`, priority }
      );
    }
    return { ...result, status };
  }
}
