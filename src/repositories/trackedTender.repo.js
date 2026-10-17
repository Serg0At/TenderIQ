import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';

const TABLE = 'tracked_tenders';

/**
 * The tenders an organisation has decided to pursue — the anchor every other
 * bid-workflow table hangs off.
 *
 * Unlike `tenders`, which is public procurement data every tenant reads from
 * the same corpus, this is private: what a supplier is chasing is competitive
 * information. So every method takes the organization id and applies it in the
 * WHERE clause. A method that accepted only a row id would be one forgotten
 * check away from telling a competitor what you are bidding on.
 */

/**
 * Cursor over (created_at, id). Ordering always carries the id tiebreaker —
 * CUID2 is not sortable, so `order by id` alone is an arbitrary order dressed
 * up as a feed, and two rows created in the same tick would repeat or vanish.
 */
const encodeCursor = (row) =>
  Buffer.from(`${new Date(row.created_at).toISOString()}|${row.id}`).toString('base64url');

const decodeCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    return id && at ? { createdAt: at, id } : null;
  } catch {
    return null;
  }
};

/** The tender columns the board needs. Selected explicitly so `t.*` cannot start leaking new columns. */
const TENDER_COLUMNS = [
  't.id as tender_id',
  't.title as tender_title',
  't.reference_code as tender_reference_code',
  't.status as tender_status',
  't.cpv_code as tender_cpv_code',
  't.estimated_value as tender_estimated_value',
  't.currency as tender_currency',
  't.deadline_at as tender_deadline_at',
  't.auction_at as tender_auction_at',
  'b.id as buyer_id',
  'b.name as buyer_name',
];

export default class TrackedTenderRepository {
  /**
   * One page of the pipeline board.
   *
   * Joins the tender rather than making the caller fan out N detail reads: a
   * board with no title and no deadline is not a board, and 20 round-trips per
   * page would put this straight through the 1.5s P95 budget.
   */
  static async listForOrg(
    organizationId,
    { status = null, limit = 20, cursor = null } = {},
    trx = db
  ) {
    const query = trx(`${TABLE} as tt`)
      .join('tenders as t', 't.id', 'tt.tender_id')
      .join('parties as b', 'b.id', 't.buyer_id')
      .leftJoin('bids as bd', 'bd.tracked_tender_id', 'tt.id')
      .where('tt.organization_id', organizationId)
      .select(
        'tt.*',
        ...TENDER_COLUMNS,
        'bd.id as bid_id',
        'bd.price as bid_price',
        'bd.lot_number as bid_lot_number',
        'bd.locked as bid_locked',
        'bd.submitted_at as bid_submitted_at',
        'bd.outcome as bid_outcome',
        'bd.winning_price as bid_winning_price'
      );

    if (status) query.whereIn('tt.status', Array.isArray(status) ? status : [status]);

    const after = decodeCursor(cursor);
    if (after) {
      query.whereRaw('(tt.created_at, tt.id) < (?, ?)', [after.createdAt, after.id]);
    }

    // One extra row answers "is there a next page?" without a second COUNT,
    // which on a joined scan costs as much as the page itself.
    const rows = await query
      .orderBy([{ column: 'tt.created_at', order: 'desc' }, { column: 'tt.id', order: 'desc' }])
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      rows: page,
      cursor: page.length ? encodeCursor(page[page.length - 1]) : null,
      hasMore,
    };
  }

  /** Counts per status — the column headers on a pipeline board. */
  static async countsByStatus(organizationId, trx = db) {
    const rows = await trx(TABLE)
      .where({ organization_id: organizationId })
      .groupBy('status')
      .select('status')
      .count('* as count');
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
  }

  static async findForOrg(id, organizationId, trx = db) {
    return trx(`${TABLE} as tt`)
      .join('tenders as t', 't.id', 'tt.tender_id')
      .join('parties as b', 'b.id', 't.buyer_id')
      .leftJoin('bids as bd', 'bd.tracked_tender_id', 'tt.id')
      .where({ 'tt.id': id, 'tt.organization_id': organizationId })
      .select(
        'tt.*',
        ...TENDER_COLUMNS,
        'bd.id as bid_id',
        'bd.price as bid_price',
        'bd.lot_number as bid_lot_number',
        'bd.currency as bid_currency',
        'bd.notes as bid_notes',
        'bd.locked as bid_locked',
        'bd.submitted_at as bid_submitted_at',
        'bd.outcome as bid_outcome',
        'bd.outcome_resolved_at as bid_outcome_resolved_at',
        'bd.winning_price as bid_winning_price'
      )
      .first();
  }

  /** The raw row, no joins — for state transitions that must not carry a stale join with them. */
  static async findRow(id, organizationId, trx = db) {
    return trx(TABLE).where({ id, organization_id: organizationId }).first();
  }

  static async findByTender(tenderId, organizationId, trx = db) {
    return trx(TABLE).where({ tender_id: tenderId, organization_id: organizationId }).first();
  }

  /**
   * Start pursuing a tender.
   *
   * `(organization_id, tender_id)` is unique, so a double-click is arbitrated
   * by the database rather than by a read-then-write that two concurrent
   * requests would both pass. A conflict returns the existing row: tracking
   * something you already track is not an error, it is a no-op.
   */
  static async track(
    { organizationId, tenderId, status = 'considering', goNoGo = null, decisionNote = null, relevance = null },
    trx = db
  ) {
    const id = createId();
    const inserted = await trx(TABLE)
      .insert({
        id,
        organization_id: organizationId,
        tender_id: tenderId,
        status,
        go_no_go: goNoGo,
        decision_note: decisionNote,
        // Written on insert only: a repeat track is a no-op and must not
        // overwrite what was shown at the moment of the decision.
        relevance_score: relevance?.score ?? null,
        relevance_shown: relevance
          ? JSON.stringify({ band: relevance.band, reasons: relevance.reasons, shownAt: relevance.shownAt })
          : null,
      })
      .onConflict(['organization_id', 'tender_id'])
      .ignore()
      .returning('id');

    const created = inserted.length > 0;
    const row = created
      ? await trx(TABLE).where({ id }).first()
      : await trx(TABLE).where({ organization_id: organizationId, tender_id: tenderId }).first();

    return { created, row };
  }

  static async update(id, organizationId, patch, trx = db) {
    const updated = await trx(TABLE)
      .where({ id, organization_id: organizationId })
      .update({ ...patch, updated_at: new Date() });
    return updated ? trx(TABLE).where({ id }).first() : null;
  }

  static async remove(id, organizationId, trx = db) {
    return trx(TABLE).where({ id, organization_id: organizationId }).del();
  }

  /**
   * Tracked tenders with a deadline inside the window — the countdown's input.
   *
   * Deliberately narrower than `notifications.dueForReminder`, which fires on
   * anything the org was ever ALERTED about. These are the ones they said out
   * loud they are pursuing, so they earn a tighter schedule. Dropped and
   * settled rows are excluded: a countdown on a tender you walked away from is
   * exactly the noise that gets an alert stream muted.
   */
  static async dueForCountdown({ until, from = new Date() }, trx = db) {
    return trx(`${TABLE} as tt`)
      .join('tenders as t', 't.id', 'tt.tender_id')
      .whereIn('tt.status', ['considering', 'preparing'])
      .andWhere('t.deadline_at', '>', from)
      .andWhere('t.deadline_at', '<=', until)
      .select(
        'tt.id as tracked_tender_id',
        'tt.organization_id',
        'tt.status',
        't.id as tender_id',
        't.title',
        't.reference_code',
        't.deadline_at'
      );
  }
}
