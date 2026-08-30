import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';

const TABLE = 'bids';

/**
 * An organisation's OWN bid — distinct from `public_tender_bids`, which is the
 * scraped ledger of everybody's bids on a finished tender.
 *
 * The two are deliberately separate tables and must stay that way. This one is
 * private tenant data that never leaves its tenant; that one is public
 * procurement record that feeds benchmarks published across the corpus. Merging
 * them would put a supplier's unsubmitted price one WHERE clause away from a
 * competitor's benchmark read.
 *
 * `tracked_tender_id` is UNIQUE, so a bid is one-per-pursuit by construction.
 */
export default class BidRepository {
  static async findForOrg(trackedTenderId, organizationId, trx = db) {
    return trx(TABLE).where({ tracked_tender_id: trackedTenderId, organization_id: organizationId }).first();
  }

  static async findById(id, organizationId, trx = db) {
    return trx(TABLE).where({ id, organization_id: organizationId }).first();
  }

  /**
   * Create or replace the draft.
   *
   * The unique constraint on `tracked_tender_id` is the arbiter again: two
   * tabs open on the same bid resolve to one row rather than to a duplicate
   * that no later read would know how to choose between.
   *
   * The caller is responsible for refusing this when the bid is locked — that
   * is a business rule with an error code attached, and it belongs in the
   * service, not in a merge clause that would silently do nothing.
   */
  static async upsertDraft({ trackedTenderId, organizationId, price, lotNumber, currency, notes }, trx = db) {
    const id = createId();
    await trx(TABLE)
      .insert({
        id,
        tracked_tender_id: trackedTenderId,
        organization_id: organizationId,
        price: price ?? null,
        lot_number: lotNumber ?? null,
        currency: currency ?? 'AMD',
        notes: notes ?? null,
      })
      .onConflict('tracked_tender_id')
      .merge({
        price: price ?? null,
        lot_number: lotNumber ?? null,
        currency: currency ?? 'AMD',
        notes: notes ?? null,
        updated_at: new Date(),
      });

    return trx(TABLE).where({ tracked_tender_id: trackedTenderId }).first();
  }

  /**
   * Lock the snapshot.
   *
   * `where locked = false` is not redundant with the service's check: between
   * the service reading the row and issuing this update, a second request can
   * submit. Making the guard part of the UPDATE means the loser of that race
   * updates 0 rows and gets told, instead of quietly overwriting a submission
   * timestamp that a supplier may need to prove.
   */
  static async submit(id, organizationId, { submittedAt = new Date() } = {}, trx = db) {
    const updated = await trx(TABLE)
      .where({ id, organization_id: organizationId, locked: false })
      .update({ locked: true, submitted_at: submittedAt, updated_at: new Date() });
    return updated ? trx(TABLE).where({ id }).first() : null;
  }

  static async remove(id, organizationId, trx = db) {
    return trx(TABLE).where({ id, organization_id: organizationId, locked: false }).del();
  }

  /**
   * Submitted bids still waiting on a result — the reconcile job's worklist.
   *
   * Joined to the tender so the job can skip anything that has not settled:
   * asking the ledger about a tender still open would resolve `not_found` for
   * every live bid and then never look again.
   */
  static async unresolved({ limit = 200 } = {}, trx = db) {
    return trx(`${TABLE} as bd`)
      .join('tracked_tenders as tt', 'tt.id', 'bd.tracked_tender_id')
      .join('tenders as t', 't.id', 'tt.tender_id')
      .where('bd.locked', true)
      .whereNull('bd.outcome')
      .whereIn('t.status', ['awarded', 'closed', 'cancelled'])
      .select(
        'bd.id',
        'bd.price',
        'bd.lot_number',
        'bd.organization_id',
        'tt.id as tracked_tender_id',
        'tt.status as tracked_status',
        't.id as tender_id',
        't.title',
        't.reference_code',
        't.status as tender_status'
      )
      .orderBy('bd.submitted_at', 'asc')
      .limit(limit);
  }

  static async recordOutcome(id, { outcome, winningPrice = null }, trx = db) {
    await trx(TABLE).where({ id }).update({
      outcome,
      winning_price: winningPrice,
      outcome_resolved_at: new Date(),
      updated_at: new Date(),
    });
    return trx(TABLE).where({ id }).first();
  }

  /**
   * How this organisation's own submitted prices compare to what actually won.
   *
   * The one dataset a competitor cannot reconstruct and the government does not
   * publish: their own numbers on the same axis as the public result. Rejected
   * public bids are excluded from nothing here because `winning_price` was
   * already resolved from an ACCEPTED rank-1 row when it was stored.
   */
  static async outcomeSummary(organizationId, trx = db) {
    const row = await trx(TABLE)
      .where({ organization_id: organizationId })
      .whereNotNull('outcome')
      .select(
        trx.raw(`count(*) filter (where outcome = 'won')::int as won`),
        trx.raw(`count(*) filter (where outcome = 'lost')::int as lost`),
        trx.raw(`count(*) filter (where outcome = 'not_found')::int as not_found`),
        trx.raw(`
          avg(
            case
              when outcome = 'lost' and winning_price > 0 and price is not null
              then (price - winning_price) / winning_price
            end
          ) as avg_gap_when_lost
        `)
      )
      .first();

    return {
      won: row?.won ?? 0,
      lost: row?.lost ?? 0,
      notFound: row?.not_found ?? 0,
      avgGapWhenLost: row?.avg_gap_when_lost === null || row?.avg_gap_when_lost === undefined
        ? null
        : Number(row.avg_gap_when_lost),
    };
  }
}
