import { UnrecoverableError } from 'bullmq';
import config from '../configs/variables.config.js';
import { JOB } from '../queues/names.js';
import CpvCodingService, { thrownReason } from '../services/cpvCoding.service.js';
import { isFinalAttempt } from '../utils/attempts.js';
import { logger } from '../utils/logger.js';

/**
 * The INFERENCE queue (cpv-inference ticket 04): inferred CPV codes for one
 * tender's lots. A lane of its own so a slow or throttled model call cannot
 * hold back alert delivery, and so ingestion never waits on it — a tender is
 * saved, matched and alerted on whatever becomes of this job.
 *
 * A throttled model call spends an attempt, the AI layer's rule (CLAUDE.md,
 * *AI layer*): a `DelayedError` never counts against the attempt budget, so a
 * quota that does not reset would loop outside it. On the last attempt the
 * lots still untried are recorded unclassified with the reason, and the error
 * is rethrown so the job stays in the failed set.
 */
const handleInferCpv = async (job) => {
  const { tenderId } = job.data ?? {};
  if (typeof tenderId !== 'string' || !tenderId) {
    throw new UnrecoverableError('cpv.infer requires tenderId');
  }

  const method = config.CPV_INFERENCE.METHOD;
  // Before any lot is touched: a method this build cannot run records nothing,
  // so its lots are still untried once it can.
  if (!CpvCodingService.isReady(method)) {
    throw new UnrecoverableError(`CPV inference method "${method}" is not built yet (cpv-inference ticket 03)`);
  }

  try {
    const result = await CpvCodingService.codeTender(tenderId, { method });
    if (result.lots) {
      logger.info(`[cpv] tender ${tenderId}: ${result.coded} of ${result.lots} lot(s) coded by ${method}`, {
        unclassified: result.unclassified,
      });
    }
    return result;
  } catch (error) {
    if (isFinalAttempt(job)) await CpvCodingService.giveUp(tenderId, thrownReason(error), { method });
    throw error;
  }
};

export const processInference = async (job) => {
  switch (job.name) {
    case JOB.INFER_CPV:
      return handleInferCpv(job);
    default:
      // A producer bug, not a transient failure: retrying burns attempts on it.
      throw new UnrecoverableError(`inference: unknown job ${job.name}`);
  }
};

export default { processInference };
