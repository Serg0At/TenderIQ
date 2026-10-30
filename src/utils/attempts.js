import { DelayedError, UnrecoverableError } from 'bullmq';

/**
 * Whether BullMQ will retry this job if it throws now. `attemptsMade` counts
 * the attempts already over, so the current one is `attemptsMade + 1`. A job
 * built by hand (a script, a replay) has neither and counts as final.
 */
export const isFinalAttempt = (job) => (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);

/**
 * Whether throwing `error` ends the job for good: not a `DelayedError` (a
 * parked job is the same job, coming back), and either unrecoverable or the
 * last attempt.
 */
export const endsJob = (job, error) =>
  !(error instanceof DelayedError) && (error instanceof UnrecoverableError || isFinalAttempt(job));

export default { isFinalAttempt, endsJob };
