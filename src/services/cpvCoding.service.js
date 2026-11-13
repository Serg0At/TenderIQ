import config from '../configs/variables.config.js';
import candidates from '../repositories/cpvCandidate.repo.js';
import inferredCpv from '../repositories/inferredCpv.repo.js';
import { nearest } from './cpvInference.service.js';
import { logger } from '../utils/logger.js';

const { AI, CPV_INFERENCE } = config;

/**
 * Coding a tender's lots at ingest (cpv-inference ticket 04, ADR 0006): every
 * lot whose source states no CPV code, and that was never tried, gets an
 * inferred code by the configured method — or is left uncoded with its reason.
 *
 * The rule for which tenders are coded (biddable, live, never a backfill) is
 * the producer's, `AddendumService.recordDocuments`, where lots are written.
 * This reads whatever candidates the tender holds when the job runs.
 *
 * Writes only `inferred_cpv_*` (inferredCpv.repo.js): no version, no event, no
 * alert. Matching does not read inferred codes yet (ticket 05).
 */

/**
 * A method: candidates in, `{ code }` or `{ unclassified: reason }` out.
 * `model` is ticket 03's and is not wired here until it lands; a job for it
 * fails without touching a lot (`isReady`), so nothing is recorded under a
 * method that never ran.
 */
const METHODS = {
  nearest: async ({ candidates: found }) => {
    const code = nearest(found);
    return code ? { code } : { unclassified: 'none' };
  },
};

/**
 * The reason a thrown inference is recorded under on the last attempt, keyed
 * by the ApiError code the AI adapter throws — the same map as the checklist
 * extractor's. Anything else is ours.
 */
const THROWN_REASON = {
  RATE_LIMITED: 'rate_limited',
  DEPENDENCY_UNAVAILABLE: 'ai_unavailable',
};

export const thrownReason = (error) => THROWN_REASON[error?.code] ?? 'internal_error';

/** The model id recorded beside a `model` outcome; null for every other method. */
const modelOf = (method) => (method === 'model' ? AI.CPV_MODEL ?? null : null);

/** One key per distinct name, so a name a tender repeats item by item is coded once. */
const nameKey = (name) => String(name).trim().replace(/\s+/g, ' ').toLowerCase();

const groupByName = (lots) => {
  const groups = new Map();
  for (const lot of lots) {
    const key = nameKey(lot.name);
    if (!groups.has(key)) groups.set(key, { name: lot.name.trim(), ids: [], lot });
    groups.get(key).ids.push(lot.id);
  }
  return [...groups.values()];
};

export default class CpvCodingService {
  /** Whether `method` can run in this build. */
  static isReady(method = CPV_INFERENCE.METHOD) {
    return Boolean(METHODS[method]);
  }

  /**
   * Code every candidate lot of one tender. Each distinct name's outcome is
   * written as soon as it is known, so a job that throws halfway (a throttled
   * model) resumes where it stopped and never pays twice for a lot.
   *
   * Returns `{ method, lots, coded, unclassified: { reason: n } }` — the
   * counts are the job's result, logged by the worker.
   */
  static async codeTender(tenderId, { method = CPV_INFERENCE.METHOD, now = new Date() } = {}) {
    const pick = METHODS[method];
    if (!pick) throw new Error(`CPV inference method "${method}" is not built`);

    const lots = await inferredCpv.lotsToCode(tenderId);
    const result = { method, lots: lots.length, coded: 0, unclassified: {} };
    if (!lots.length) return result;

    const classifierVersion = await inferredCpv.classifierVersion();
    // A deployment that never ran `cpv:refresh`: there is nothing to choose
    // from, and recording every lot as unclassified would hide that.
    if (!classifierVersion) throw new Error('the CPV classifier is empty — run npm run cpv:refresh -- --apply');

    for (const group of groupByName(lots)) {
      const found = await candidates.candidatesFor({ lotId: group.lot.id, name: group.name });
      const outcome = await pick({
        name: group.name,
        tender: { title: group.lot.title, description: group.lot.description ?? null },
        candidates: found,
      });

      // Chosen, never written: a code that is not among the candidates — each
      // a live classifier code — is refused here, whatever produced it.
      let { code = null, unclassified = null } = outcome;
      if (code && !found.some((c) => c.code === code)) {
        code = null;
        unclassified = 'invalid_code';
      }

      const written = await inferredCpv.record(group.ids, {
        code,
        unclassified: code ? null : unclassified ?? 'none',
        method,
        model: outcome.model ?? modelOf(method),
        classifierVersion,
        at: now,
      });
      if (code) result.coded += written;
      else result.unclassified[unclassified ?? 'none'] = (result.unclassified[unclassified ?? 'none'] ?? 0) + written;
    }
    return result;
  }

  /**
   * The last attempt threw: record every lot still to be coded as
   * unclassified under `reason`, so it is counted rather than left looking
   * untried. A failed write is logged and swallowed — the error worth
   * rethrowing is the one that failed the job.
   */
  static async giveUp(tenderId, reason, { method = CPV_INFERENCE.METHOD, now = new Date() } = {}) {
    try {
      const lots = await inferredCpv.lotsToCode(tenderId);
      const classifierVersion = await inferredCpv.classifierVersion();
      if (!lots.length || !classifierVersion) return 0;
      const written = await inferredCpv.record(
        lots.map((l) => l.id),
        { unclassified: reason, method, model: modelOf(method), classifierVersion, at: now }
      );
      logger.warn(`[cpv] tender ${tenderId}: ${written} lot(s) left unclassified after the last attempt (${reason})`);
      return written;
    } catch (error) {
      logger.error(`[cpv] tender ${tenderId}: could not record its lots as unclassified: ${error.message}`);
      return 0;
    }
  }
}
