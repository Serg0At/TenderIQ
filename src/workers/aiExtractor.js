import checklists from '../repositories/checklist.repo.js';
import trackedTenders from '../repositories/trackedTender.repo.js';
import tenders from '../repositories/tender.repo.js';
import ChecklistExtractionService from '../services/checklistExtraction.service.js';
import { getStorage } from '../libs/storage/index.js';
import { logger } from '../utils/logger.js';

/**
 * The AI checklist stage — read a tender invitation, produce the list of things
 * the supplier must provide.
 *
 * A worker rather than a request handler, for two reasons that are not about
 * speed. A model call over a full invitation takes tens of seconds, which is
 * past any reasonable HTTP budget; and it costs money per call, so it must be
 * driven by an explicit user action that lands in a queue with retry semantics,
 * never by a page load that a refresh can repeat.
 *
 * It duplicates no business logic: the extraction rules live in
 * `checklistExtraction.service.js`, which the API would call too.
 */

/**
 * Fetch the extracted invitation text for a tender.
 *
 * `tender_documents.storage_key` points at the ZIP; the document stage writes
 * the extracted text beside it under the same key with a `.txt` extension, so
 * the text key is derived rather than stored a second time — two columns that
 * must agree is one more thing to keep in step.
 *
 * Returns a null text with a reason rather than throwing when there is no
 * document. Most tenders do not have one: the invitation archive is only
 * fetched for some, and a settled tender never emits the event that would
 * enqueue it. "No document" is the common case, not an error.
 *
 * An ARMEPS tender's archive (`contract_documents`) is stored, but nothing
 * extracts text from it yet — only the e-auction document stage writes the
 * `.txt`. That answers `unsupported_document` rather than `no_document`: the
 * file exists, and saying otherwise would hide the gap behind the common path,
 * the same way this function once hid a lost storage key.
 */
export const loadInvitationText = async (tenderId) => {
  const tender = await tenders.findWithStoredDocuments(tenderId);
  const title = tender?.title ?? null;
  const invitation = tender?.documents.find((d) => d.kind === 'invitation');
  if (!invitation) {
    const reason = tender?.documents.length ? 'unsupported_document' : 'no_document';
    return { text: null, title, reason };
  }

  const storage = await getStorage();
  const textKey = invitation.storage_key.replace(/\.zip$/, '.txt');

  try {
    const body = await storage.get(textKey);
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
    return { text: text || null, title, reason: text ? null : 'no_text' };
  } catch (error) {
    /**
     * A missing text object is not a missing document — the archive exists and
     * the parser simply produced no text, or the object predates the stage
     * that writes it. Either way it is `unavailable`, not a crash, and
     * re-running the document stage is the repair.
     */
    logger.warn(`[ai] no extracted text at ${textKey}: ${error.message}`);
    return { text: null, title, reason: 'no_text' };
  }
};

/**
 * Generate (or regenerate) the checklist for one tracked tender.
 *
 * Idempotent on the document: if the checklist was already built from this
 * exact text, the model is not called again. Re-reading an unchanged document
 * cannot produce a better answer, and it would charge for the privilege —
 * `force` exists for the case where the prompt itself changed.
 */
export const handleChecklistExtract = async (job) => {
  const { trackedTenderId, organizationId, force = false } = job.data ?? {};

  if (!trackedTenderId || !organizationId) {
    // A malformed payload is a bug in a producer, not a transient failure —
    // retrying it just burns attempts on the same bad job.
    logger.error('[ai] checklist.extract received a payload with no tracked tender or org');
    return { skipped: 'invalid_payload' };
  }

  const tracked = await trackedTenders.findRow(trackedTenderId, organizationId);
  if (!tracked) {
    // Dropped between enqueue and run. Not an error worth retrying.
    logger.info(`[ai] tracked tender ${trackedTenderId} no longer exists — skipping`);
    return { skipped: 'not_found' };
  }

  const checklist = await checklists.ensure({ trackedTenderId, organizationId });

  try {
    return await extractInto(checklist, tracked, { force });
  } catch (error) {
    if (isFinalAttempt(job)) await markThrown(checklist, error);
    // Rethrown either way, so BullMQ still retries or records the failure.
    throw error;
  }
};

/**
 * The reason a thrown extraction is recorded under, keyed by the ApiError code
 * the AI adapter throws. Anything else is an internal failure, not the model's.
 *
 * A throttle spends attempts like any other dependency failure — deliberately
 * not the `moveToDelayed` + `DelayedError` that ingestion uses. A delayed job
 * never increments `attemptsMade`, so a quota that does not reset would loop
 * delayed → active → delayed outside the attempt budget, every one of those a
 * live state: the checklist stuck `pending` and every generate a 409, which is
 * the bug this exists to end. The adapter carries no retry-after to wait for.
 */
const THROWN_REASON = {
  RATE_LIMITED: 'rate_limited',
  DEPENDENCY_UNAVAILABLE: 'ai_unavailable',
};

/**
 * Whether BullMQ will retry this job if it throws now. `attemptsMade` counts
 * the attempts already over, so the current one is `attemptsMade + 1`. A job
 * built by hand (a script, a replay) has neither and counts as final.
 */
const isFinalAttempt = (job) => (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);

/**
 * Record a thrown extraction as `failed`, on the last attempt only.
 *
 * Without this the row stays `pending` after BullMQ gives up, which reads as
 * work in progress forever. Before the last attempt the row is left `pending`
 * on purpose — a retry is still coming, and `failed` would tell the client to
 * give up on a checklist that is about to arrive.
 *
 * A failed write here is logged and swallowed: the error worth rethrowing is
 * the one that failed the job, not this one.
 */
const markThrown = async (checklist, error) => {
  const failureReason = THROWN_REASON[error?.code] ?? 'internal_error';
  try {
    await checklists.markStatus(checklist.id, { status: 'failed', failureReason });
    logger.warn(`[ai] checklist ${checklist.id} failed after its last attempt (${failureReason}): ${error.message}`);
  } catch (markError) {
    logger.error(`[ai] checklist ${checklist.id} could not be marked failed: ${markError.message}`);
  }
};

/** Read the invitation and write the checklist — everything after the row exists. */
const extractInto = async (checklist, tracked, { force }) => {
  const trackedTenderId = tracked.id;
  const organizationId = checklist.organization_id;
  const { text, title, reason } = await loadInvitationText(tracked.tender_id);

  if (!text) {
    /**
     * The honest empty answer.
     *
     * `unavailable` with a reason, never a checklist with zero items — an
     * empty list reads as "nothing is required for this tender", which is the
     * most dangerous thing this feature could tell a supplier.
     */
    await checklists.markStatus(checklist.id, { status: 'unavailable', failureReason: reason });
    logger.info(`[ai] tender ${tracked.tender_id} has no invitation text (${reason}) — checklist unavailable`);
    return { status: 'unavailable', reason };
  }

  const result = await ChecklistExtractionService.extract({ documentText: text, tenderTitle: title });

  // Skip the model when the stored checklist already came from this exact
  // document. Checked after loading the text because the hash IS the document.
  if (
    !force &&
    checklist.status === 'ready' &&
    checklist.document_hash &&
    checklist.document_hash === result.documentHash
  ) {
    logger.info(`[ai] checklist for ${trackedTenderId} is already current — not re-extracting`);
    return { status: 'unchanged' };
  }

  if (result.status !== 'ready') {
    await checklists.markStatus(checklist.id, {
      status: result.status === 'unavailable' ? 'unavailable' : 'failed',
      failureReason: result.reason ?? null,
    });
    return { status: result.status, reason: result.reason };
  }

  await checklists.replaceItems({
    checklistId: checklist.id,
    organizationId,
    items: result.items,
    meta: { status: 'ready', model: result.model, documentHash: result.documentHash },
  });

  logger.info(
    `[ai] checklist for ${trackedTenderId}: ${result.stats.kept} item(s) kept ` +
      `(${result.stats.droppedUnverifiable} dropped as unverifiable, ` +
      `${result.stats.needsReview} flagged for review), quality=${result.documentQuality}` +
      (result.usage ? `, cache_read=${result.usage.cache_read_input_tokens ?? 0}` : '')
  );

  return { status: 'ready', ...result.stats };
};

export default { handleChecklistExtract, loadInvitationText };
