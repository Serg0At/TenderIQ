/**
 * Whether BullMQ will retry this job if it throws now. `attemptsMade` counts
 * the attempts already over, so the current one is `attemptsMade + 1`. A job
 * built by hand (a script, a replay) has neither and counts as final.
 */
export const isFinalAttempt = (job) => (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);

export default { isFinalAttempt };
