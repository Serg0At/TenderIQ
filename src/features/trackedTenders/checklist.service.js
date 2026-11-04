import checklists from '../../repositories/checklist.repo.js';
import trackedTenders from '../../repositories/trackedTender.repo.js';
import vaultDocuments from '../../repositories/vaultDocument.repo.js';
import tenders from '../../repositories/tender.repo.js';
import VaultDocumentService, { expiryOf } from '../vault/vaultDocument.service.js';
import ChecklistExtractionService from '../../services/checklistExtraction.service.js';
import ai from '../../libs/adapters/ai/anthropic.js';
import { alertsQueue } from '../../queues/index.js';
import { JOB, PRIORITY } from '../../queues/names.js';
import { ApiError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import config from '../../configs/variables.config.js';

const { AI } = config;

/**
 * BullMQ states in which a job will still run. A prioritized job is not
 * `waiting` — it has its own state — and every checklist job is prioritized.
 */
const LIVE_JOB_STATES = new Set(['waiting', 'prioritized', 'delayed', 'active', 'waiting-children']);

/**
 * The bid checklist as an API resource.
 *
 * Generation is asynchronous — the endpoint enqueues and returns 202 rather
 * than blocking a request for the tens of seconds a model call over a full
 * invitation takes. The client polls the checklist, whose `status` is the
 * honest state machine: `pending` while the job runs, then `ready`,
 * `unavailable` (no document to read) or `failed`.
 */

const presentItem = (row) => ({
  id: row.id,
  label: row.label,
  category: row.category,
  required: row.required,
  done: row.done,
  confidence: row.confidence === null ? null : Number(row.confidence),
  /**
   * The verbatim source line. Returned on every item, because it is what makes
   * an AI-extracted requirement checkable rather than something to be taken on
   * faith — a supplier can match it against the PDF in seconds.
   */
  evidence: row.evidence,
  needsReview: row.needs_review,
  source: row.source,
  reviewedAt: row.reviewed_at ?? null,
  /**
   * The vault document that satisfies this requirement, when one is attached.
   *
   * Its expiry is recomputed on read rather than trusted from the moment of
   * attachment — a certificate attached in March and valid until June is fine in
   * April and disqualifying in July, and the checklist is exactly where someone
   * would look to find that out. Attaching is guarded by BR-12; staying attached
   * as the clock runs is not something a guard can prevent, only report.
   */
  document: row.vault_document_id
    ? {
        id: row.vault_document_id,
        kind: row.vault_kind ?? null,
        filename: row.vault_filename ?? null,
        attachedAt: row.attached_at ?? null,
        expiry: expiryOf(row.vault_valid_until ?? null),
      }
    : null,
});

const present = (checklist, items, progress, itemsCurrent) => ({
  id: checklist.id,
  status: checklist.status,
  source: checklist.source,
  /** Provenance, on the wire — which model produced this, and when. */
  model: checklist.model ?? null,
  generatedAt: checklist.generated_at ?? null,
  failureReason: checklist.failure_reason ?? null,
  /**
   * Whether the AI items come from the invitation the tender holds now. A
   * `false` is a warning a client must show: the buyer changed the document
   * after these items were read, so some may no longer hold — the same danger
   * as an empty list, a supplier preparing against the wrong requirements.
   */
  itemsCurrent,
  progress,
  items: items.map(presentItem),
  /**
   * Stated on every response, not buried in docs. Everything here is extracted
   * by a model from a scraped document; it assists a bid decision and is not a
   * legal reading of the tender.
   */
  advisory: true,
});

export default class ChecklistService {
  static async forTracked(organizationId, trackedTenderId) {
    const tracked = await trackedTenders.findRow(trackedTenderId, organizationId);
    if (!tracked) throw ApiError.notFound('Tracked tender');

    const checklist = await checklists.findForTracked(trackedTenderId, organizationId);
    if (!checklist) {
      // Not an error: a pursuit simply has no checklist until one is asked for.
      return { status: 'absent', itemsCurrent: null, items: [], progress: null, advisory: true };
    }

    const [items, progress, invitation] = await Promise.all([
      checklists.itemsFor(checklist.id, organizationId),
      checklists.progress(checklist.id, organizationId),
      tenders.findCurrentInvitation(tracked.tender_id),
    ]);
    const itemsCurrent = ChecklistExtractionService.itemsCurrent(
      {
        documentHash: checklist.document_hash,
        aiItemCount: items.filter((item) => item.source === 'ai').length,
      },
      invitation ? { textHash: invitation.text_hash } : null
    );
    return present(checklist, items, progress, itemsCurrent);
  }

  /**
   * Ask for a checklist. Returns immediately; the worker does the reading.
   *
   * Refuses up front when the AI layer is unconfigured, rather than enqueueing
   * a job that is certain to fail — a queue full of jobs that cannot succeed
   * is worse than an honest 503, because it looks like work in progress.
   */
  static async generate(organizationId, trackedTenderId, { force = false } = {}) {
    const tracked = await trackedTenders.findRow(trackedTenderId, organizationId);
    if (!tracked) throw ApiError.notFound('Tracked tender');

    if (!ai.isConfigured()) {
      throw new ApiError('DEPENDENCY_UNAVAILABLE', {
        message: 'AI checklist extraction is not configured.',
      });
    }

    // The tracked tender is the natural idempotency key: two clicks while one
    // extraction is in flight must not buy two model calls. Hyphenated, because
    // BullMQ throws on a `:` id that does not split into three parts.
    const jobId = `checklist-${trackedTenderId}`;
    const previous = await alertsQueue.getJob(jobId);
    const inFlight = previous ? LIVE_JOB_STATES.has(await previous.getState()) : false;

    /**
     * The JOB is what is in flight, never the row. A `pending` row can outlive
     * its job — removed, a flushed Redis, a crash between marking the row and
     * the `add` below — and then no handler runs to move it on, so refusing on
     * the row's status alone would refuse forever. The reverse also happens: a
     * job that has just written `failed` or `ready` is still `active` for a
     * moment, and adding under its id then would be a no-op behind a 202.
     *
     * `force` does not get past this either: it re-reads an unchanged document,
     * and a job that is already running cannot be told to.
     */
    if (inFlight) {
      throw ApiError.conflict('A checklist is already being generated for this tender.');
    }

    const existing = await checklists.findForTracked(trackedTenderId, organizationId);
    const checklist = await checklists.ensure({ trackedTenderId, organizationId });
    if (existing) await checklists.markStatus(checklist.id, { status: 'pending' });

    // A FINISHED job keeps its id — completed ones for a day, failed ones for
    // good — and adding under a taken id is a silent no-op. Without this a
    // regenerate would mark the checklist pending and never run. A remove that
    // loses a race to a concurrent click is harmless — exactly one job holds
    // the id afterwards — so it is logged, not thrown; anything worse leaves
    // a pending row with no job, which the next click re-runs.
    if (previous) {
      await previous.remove().catch((error) => logger.warn(`[checklist] ${jobId} not removed: ${error.message}`));
    }

    await alertsQueue.add(
      JOB.EXTRACT_CHECKLIST,
      { trackedTenderId, organizationId, force },
      { priority: PRIORITY.LIVE, jobId }
    );

    return { id: checklist.id, status: 'pending', advisory: true };
  }

  static async updateItem(organizationId, itemId, patch) {
    const updated = await checklists.updateItem(itemId, organizationId, patch);
    if (!updated) throw ApiError.notFound('Checklist item');
    return presentItem(updated);
  }

  /**
   * Add a requirement the model missed.
   *
   * Manual items are marked as such and survive a regenerate — a human who
   * corrects the machine must not lose the correction the next time someone
   * presses the button, or they stop correcting it.
   */
  static async addItem(organizationId, trackedTenderId, input) {
    const tracked = await trackedTenders.findRow(trackedTenderId, organizationId);
    if (!tracked) throw ApiError.notFound('Tracked tender');

    const checklist = await checklists.ensure({ trackedTenderId, organizationId });
    const row = await checklists.addManualItem({
      checklistId: checklist.id,
      organizationId,
      label: input.label,
      category: input.category,
      required: input.required,
    });
    return presentItem(row);
  }

  static async removeItem(organizationId, itemId) {
    const deleted = await checklists.removeItem(itemId, organizationId);
    if (!deleted) throw ApiError.notFound('Checklist item');
    return { deleted: true };
  }

  /**
   * Satisfy a requirement with a document from the vault — or detach one.
   *
   * This is where BR-12 bites: an expired certificate cannot be attached to a
   * bid. The check is delegated to `VaultDocumentService.assertAttachable`
   * rather than reimplemented here, because the bid package (phase 5) will be
   * the second attachment point and a rule written twice is a rule that will
   * eventually disagree with itself.
   *
   * Detaching (`null`) is deliberately unguarded: attaching the wrong
   * certificate is the easiest mistake in the feature, and a rule that made a
   * mistake permanent would be a worse rule.
   */
  static async attachDocument(organizationId, itemId, vaultDocumentId) {
    if (vaultDocumentId) await VaultDocumentService.assertAttachable(organizationId, vaultDocumentId);

    const updated = await checklists.attachDocument({ itemId, organizationId, vaultDocumentId });
    if (!updated) throw ApiError.notFound('Checklist item');

    // Re-read the document for the presenter rather than carrying it through:
    // one indexed lookup, and it keeps `presentItem` reading from one shape
    // whether the item came from a list query or from this write.
    const document = vaultDocumentId
      ? await vaultDocuments.findRow(vaultDocumentId, organizationId)
      : null;

    return presentItem({
      ...updated,
      vault_kind: document?.kind ?? null,
      vault_filename: document?.filename ?? null,
      vault_valid_until: document?.valid_until ?? null,
    });
  }

  /** The confidence line, so a client can explain why an item is flagged. */
  static get reviewThreshold() {
    return AI.CHECKLIST_MIN_CONFIDENCE;
  }
}
