import { withTransaction } from '../libs/knex.js';
import tenders from '../repositories/tender.repo.js';
import tenderSources from '../repositories/tenderSource.repo.js';
import { failureStatus } from './resolution.service.js';

/**
 * Failure notices on a tender (ticket 09): gnumner's «Չկայացած» names the lots
 * that failed, and a tender is cancelled once its notices, together, name
 * every lot it has (`resolution.service.js#failureStatus`).
 *
 * Either side can arrive first. A notice read before its tender's lots were
 * written — an ARMEPS tender whose document archive comes later, a paper
 * tender whose notice was re-read the moment it was created — is linked with
 * its lots and changes nothing; the lots, when they are written, complete it.
 * So the decision is always taken from what is stored, under the tender's row
 * lock, by whichever write came second — never from what a caller read
 * before: no notice is downloaded or read again, and two writers at once
 * cannot each miss the other.
 */
export default class FailureService {
  /**
   * Derive the tender's status again from its stored lots and failure
   * notices, inside the caller's transaction (it locks the row, which the
   * caller may hold already). A status that moves is one more version and a
   * `TenderAmended` event, for the caller to hand to the matcher after the
   * commit. Null when the tender is gone.
   */
  static async rederive(tenderId, trx, now = new Date()) {
    const facts = await tenders.findFailureFacts(tenderId, trx);
    if (!facts) return null;
    const status = failureStatus(facts, facts.failures, now);
    const outcome = {
      tenderId,
      status,
      lotNumbers: facts.lotNumbers,
      failedLots: [...new Set(facts.failures.flatMap((failure) => failure.lots))].sort((a, b) => a - b),
    };
    if (status === facts.status) return { ...outcome, event: null, version: facts.version };
    const version = await tenders.advanceVersion(tenderId, { status }, trx);
    return { ...outcome, event: 'TenderAmended', version, changedFields: ['status'] };
  }

  /**
   * A failure notice resolution matched to a tender: its link — `cancelled`,
   * and the lots it named — and the status that follows from every notice the
   * tender now holds. One transaction under the row lock. A notice recorded
   * again moves nothing.
   */
  static async recordNotice({ tenderId, link }, now = new Date()) {
    return withTransaction(async (trx) => {
      if (!(await tenders.findFailureFacts(tenderId, trx))) {
        throw new Error(`[failure] resolved tender ${tenderId} no longer exists — re-resolve`);
      }
      await tenderSources.upsert({ ...link, tenderId }, trx);
      return FailureService.rederive(tenderId, trx, now);
    });
  }
}
