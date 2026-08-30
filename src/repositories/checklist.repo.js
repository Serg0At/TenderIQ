import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';

const TABLE = 'checklists';
const ITEMS = 'checklist_items';

/**
 * The bid checklist and its items — private tenant data, scoped by
 * organisation in every method.
 *
 * Both tables carry `organization_id` and are anchored to their parent by a
 * composite foreign key, so a checklist item cannot claim a tenant its
 * checklist does not belong to. Without the denormalised column, isolating an
 * item would mean joining three tables (item → checklist → tracked_tender),
 * which is the shape that eventually gets a join dropped.
 */
export default class ChecklistRepository {
  static async findForTracked(trackedTenderId, organizationId, trx = db) {
    return trx(TABLE)
      .where({ tracked_tender_id: trackedTenderId, organization_id: organizationId })
      .first();
  }

  /**
   * A checklist's items, with the vault document attached to each.
   *
   * Left joined rather than fanned out: a checklist runs to dozens of items, and
   * one lookup per attachment would put a page well past the 1.5s P95 budget.
   * The join is on the composite key, so it cannot reach another tenant's
   * document even if `vault_document_id` somehow held one.
   */
  static async itemsFor(checklistId, organizationId, trx = db) {
    return trx(`${ITEMS} as ci`)
      .leftJoin('vault_documents as vd', function joinVault() {
        this.on('vd.id', 'ci.vault_document_id').andOn(
          'vd.organization_id',
          'ci.organization_id'
        );
      })
      .where({ 'ci.checklist_id': checklistId, 'ci.organization_id': organizationId })
      .select(
        'ci.*',
        'vd.kind as vault_kind',
        'vd.filename as vault_filename',
        'vd.valid_until as vault_valid_until'
      )
      // sort_order is the model's own ordering; the id tiebreaker keeps two
      // items written in the same tick from swapping places between reads.
      .orderBy([{ column: 'ci.sort_order' }, { column: 'ci.id' }]);
  }

  /**
   * The checklist row, created on demand.
   *
   * `tracked_tender_id` is UNIQUE, so the database arbitrates two concurrent
   * "generate" clicks rather than a read-then-write that both would pass.
   */
  static async ensure({ trackedTenderId, organizationId }, trx = db) {
    const id = createId();
    await trx(TABLE)
      .insert({ id, tracked_tender_id: trackedTenderId, organization_id: organizationId, status: 'pending' })
      .onConflict('tracked_tender_id')
      .ignore();
    return trx(TABLE).where({ tracked_tender_id: trackedTenderId }).first();
  }

  /**
   * Replace a checklist's AI-extracted items wholesale, in one transaction.
   *
   * Wholesale replace rather than merge, for the same reason the bid ledger is
   * replaced on re-normalize: a re-extraction is a new reading of the document,
   * and diffing two AI outputs to decide which items "are the same" would
   * invent a correspondence that does not exist.
   *
   * MANUAL items survive. A human who added a requirement the model missed
   * must not lose it because someone pressed regenerate — that would teach
   * people not to add anything.
   */
  static async replaceItems({ checklistId, organizationId, items, meta }, trx = db) {
    const run = async (t) => {
      await t(ITEMS).where({ checklist_id: checklistId, source: 'ai' }).del();

      if (items.length) {
        await t(ITEMS).insert(
          items.map((item) => ({
            id: createId(),
            checklist_id: checklistId,
            organization_id: organizationId,
            label: item.label,
            category: item.category,
            required: item.required,
            confidence: item.confidence,
            evidence: item.evidence,
            needs_review: item.needsReview,
            sort_order: item.sortOrder,
            source: 'ai',
          }))
        );
      }

      await t(TABLE).where({ id: checklistId }).update({
        status: meta.status,
        model: meta.model ?? null,
        document_hash: meta.documentHash ?? null,
        failure_reason: meta.failureReason ?? null,
        generated_at: new Date(),
        updated_at: new Date(),
      });

      return t(TABLE).where({ id: checklistId }).first();
    };

    // Reuse an outer transaction when given one; open our own otherwise, so
    // items and status can never be left disagreeing.
    return trx === db ? db.transaction(run) : run(trx);
  }

  static async markStatus(checklistId, { status, failureReason = null }, trx = db) {
    await trx(TABLE).where({ id: checklistId }).update({
      status,
      failure_reason: failureReason,
      updated_at: new Date(),
    });
    return trx(TABLE).where({ id: checklistId }).first();
  }

  /**
   * Tick an item, or clear a review flag.
   *
   * Scoped by organisation in the WHERE clause rather than by the caller
   * checking first — that is the repository's job, and a method that took only
   * an item id would be one forgotten check from a cross-tenant write.
   */
  static async updateItem(id, organizationId, patch, trx = db) {
    const next = {
      ...(patch.done !== undefined ? { done: patch.done } : {}),
      ...(patch.required !== undefined ? { required: patch.required } : {}),
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      // Clearing the flag is a human saying "I checked this", so it is stamped.
      ...(patch.needsReview !== undefined
        ? { needs_review: patch.needsReview, reviewed_at: patch.needsReview ? null : new Date() }
        : {}),
    };
    if (!Object.keys(next).length) return trx(ITEMS).where({ id, organization_id: organizationId }).first();

    const updated = await trx(ITEMS).where({ id, organization_id: organizationId }).update(next);
    return updated ? trx(ITEMS).where({ id }).first() : null;
  }

  /** A human-authored item. `source: 'manual'` is what protects it from regenerate. */
  static async addManualItem({ checklistId, organizationId, label, category, required }, trx = db) {
    const id = createId();
    const [{ max }] = await trx(ITEMS).where({ checklist_id: checklistId }).max('sort_order as max');
    await trx(ITEMS).insert({
      id,
      checklist_id: checklistId,
      organization_id: organizationId,
      label,
      category: category ?? null,
      required: required ?? true,
      // No confidence and no evidence: a person asserted this, and dressing it
      // up with a fabricated 1.0 would make human and model items
      // indistinguishable in exactly the place that matters.
      confidence: null,
      evidence: null,
      needs_review: false,
      sort_order: Number(max ?? 0) + 1,
      source: 'manual',
    });
    return trx(ITEMS).where({ id }).first();
  }

  static async removeItem(id, organizationId, trx = db) {
    return trx(ITEMS).where({ id, organization_id: organizationId }).del();
  }

  /**
   * Point a requirement at the vault document that satisfies it.
   *
   * Whether that document is expired is decided in the service, not here — BR-12
   * is a business rule about what may be attached, and a repository that
   * silently refused a write would give the caller no way to say why. The
   * composite foreign key is what makes the *tenant* half unrepresentable; the
   * expiry half is a decision.
   *
   * `attached_at` is stamped rather than derived: it records when someone
   * asserted this document answers this requirement, which stays meaningful
   * after the document itself is replaced.
   */
  static async attachDocument({ itemId, organizationId, vaultDocumentId }, trx = db) {
    const updated = await trx(ITEMS)
      .where({ id: itemId, organization_id: organizationId })
      .update({
        vault_document_id: vaultDocumentId,
        attached_at: vaultDocumentId ? new Date() : null,
      });
    return updated ? trx(ITEMS).where({ id: itemId }).first() : null;
  }

  /**
   * Detach every item pointing at a document, ahead of deleting it.
   *
   * The foreign key would clear `vault_document_id` on its own, but it cannot
   * clear `attached_at` — leaving a timestamp saying a document was attached
   * with nothing attached. Doing it explicitly also keeps the FK as a backstop
   * for deletion paths this code does not drive, such as an organisation being
   * cascaded away.
   */
  static async detachDocument(vaultDocumentId, organizationId, trx = db) {
    return trx(ITEMS)
      .where({ vault_document_id: vaultDocumentId, organization_id: organizationId })
      .update({ vault_document_id: null, attached_at: null });
  }

  /**
   * Checklist items across the organisation that are satisfied by a given
   * document.
   *
   * Read before a vault document is deleted, so the answer to "what breaks if I
   * remove this?" is a list rather than a surprise. The foreign key is
   * ON DELETE SET NULL, so the items survive — they simply become unmet again,
   * which is the truth.
   */
  static async itemsUsingDocument(vaultDocumentId, organizationId, trx = db) {
    return trx(`${ITEMS} as ci`)
      .join(`${TABLE} as c`, 'c.id', 'ci.checklist_id')
      .where({ 'ci.vault_document_id': vaultDocumentId, 'ci.organization_id': organizationId })
      .select('ci.id', 'ci.label', 'ci.required', 'c.tracked_tender_id');
  }

  /** Progress for the board: how much of the checklist is done. */
  static async progress(checklistId, organizationId, trx = db) {
    const row = await trx(ITEMS)
      .where({ checklist_id: checklistId, organization_id: organizationId })
      .select(
        trx.raw('count(*)::int as total'),
        trx.raw('count(*) filter (where done)::int as done'),
        trx.raw('count(*) filter (where required and not done)::int as outstanding_required'),
        trx.raw('count(*) filter (where needs_review)::int as needs_review')
      )
      .first();
    return {
      total: row?.total ?? 0,
      done: row?.done ?? 0,
      outstandingRequired: row?.outstanding_required ?? 0,
      needsReview: row?.needs_review ?? 0,
    };
  }
}
