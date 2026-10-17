import trackedTenders from '../../repositories/trackedTender.repo.js';
import bids from '../../repositories/bid.repo.js';
import tenders from '../../repositories/tender.repo.js';
import organizations from '../../repositories/organization.repo.js';
import parties from '../../repositories/party.repo.js';
import BidOutcomeService from '../../services/bidOutcome.service.js';
import { verifyRelevance } from '../../libs/relevanceReceipt.js';
import config from '../../configs/variables.config.js';
import { ApiError } from '../../utils/errors.js';

/**
 * The bid pipeline: what an organisation is pursuing, and what it bid.
 *
 * `tracked_tenders` is the anchor the rest of phase 4 hangs off — bids and
 * checklists both reference it — so its state machine is defined here once
 * rather than re-derived by each of them.
 */

/**
 * Legal transitions. Written as data, because a state machine expressed as
 * scattered `if` statements is one forgotten branch away from letting a
 * submitted bid slide back to a draft.
 *
 * `submitted` is a one-way door in one direction only: it can still become
 * `won` or `lost`, but never `preparing`. A submitted bid is a locked snapshot
 * — that is a business rule, and reopening it would let a supplier rewrite what
 * they claim to have offered after seeing the result.
 */
const TRANSITIONS = {
  considering: ['preparing', 'dropped'],
  preparing: ['considering', 'submitted', 'dropped'],
  submitted: ['won', 'lost'],
  won: [],
  lost: [],
  // Reopening a dropped pursuit is a change of mind, not a rule violation.
  dropped: ['considering'],
};

const present = (row) => ({
  id: row.id,
  status: row.status,
  goNoGo: row.go_no_go,
  decisionNote: row.decision_note,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  // What the relevant list showed when this was tracked from it — null when it
  // was tracked from anywhere else. Recorded once and never recomputed.
  relevance:
    row.relevance_score === null || row.relevance_score === undefined
      ? null
      : { score: Number(row.relevance_score), ...row.relevance_shown },
  tender: {
    id: row.tender_id,
    title: row.tender_title,
    referenceCode: row.tender_reference_code,
    status: row.tender_status,
    cpvCode: row.tender_cpv_code,
    estimatedValue: row.tender_estimated_value === null ? null : Number(row.tender_estimated_value),
    currency: row.tender_currency,
    deadlineAt: row.tender_deadline_at,
    auctionAt: row.tender_auction_at,
    buyer: { id: row.buyer_id, name: row.buyer_name },
  },
  bid: row.bid_id ? presentBid(row) : null,
});

/**
 * The bid as it appears joined onto a tracked tender. `gapVsWinner` is computed
 * here rather than stored: it is a pure function of two stored numbers, and a
 * derived column would be one more thing to keep in step.
 */
const presentBid = (row) => {
  const price = row.bid_price === null || row.bid_price === undefined ? null : Number(row.bid_price);
  const winning =
    row.bid_winning_price === null || row.bid_winning_price === undefined
      ? null
      : Number(row.bid_winning_price);

  return {
    id: row.bid_id,
    price,
    lotNumber: row.bid_lot_number ?? null,
    currency: row.bid_currency ?? 'AMD',
    notes: row.bid_notes ?? null,
    locked: row.bid_locked ?? false,
    submittedAt: row.bid_submitted_at ?? null,
    outcome: row.bid_outcome ?? null,
    outcomeResolvedAt: row.bid_outcome_resolved_at ?? null,
    winningPrice: winning,
    gapVsWinner: price !== null && winning !== null && winning > 0 ? (price - winning) / winning : null,
  };
};

export default class TrackedTenderService {
  static async list(organizationId, query = {}) {
    const page = query.page ?? {};
    const { rows, cursor, hasMore } = await trackedTenders.listForOrg(organizationId, {
      status: query.filter?.status ?? null,
      limit: page.size ?? 20,
      cursor: page.cursor || null,
    });
    return { rows: rows.map(present), cursor, hasMore };
  }

  /** Column headers for a pipeline board — every status present, including the empty ones. */
  static async board(organizationId) {
    const counts = await trackedTenders.countsByStatus(organizationId);
    return {
      counts: Object.fromEntries(Object.keys(TRANSITIONS).map((s) => [s, counts[s] ?? 0])),
      total: Object.values(counts).reduce((sum, n) => sum + n, 0),
    };
  }

  static async detail(organizationId, id) {
    const row = await trackedTenders.findForOrg(id, organizationId);
    if (!row) throw ApiError.notFound('Tracked tender');
    return present(row);
  }

  /**
   * Start pursuing a tender.
   *
   * The tender is verified to exist first, so a bad id answers 404 rather than
   * a foreign-key violation the error handler would report as INTERNAL_ERROR.
   * Tracking something already tracked returns the existing row — a supplier
   * clicking "pursue" twice has not made a mistake worth an error page.
   *
   * `relevance` is what the relevant list showed for this tender, handed back
   * verbatim. It is recorded only if its signature proves this organization was
   * shown exactly that for exactly this tender; a mismatch is a 422 rather than
   * a silent drop, because a client that sends a broken one has a bug worth
   * seeing. Omitted, nothing is recorded and the pursuit works as before.
   */
  static async track(organizationId, { tenderId, status, goNoGo, decisionNote, relevance = null }) {
    const tender = await tenders.findDetail(tenderId);
    if (!tender) throw ApiError.notFound('Tender');

    if (relevance && !verifyRelevance(organizationId, tenderId, relevance)) {
      throw ApiError.validation([
        {
          field: 'relevance',
          message: 'This is not what the relevant list showed for this tender. Send it back unchanged, or omit it.',
        },
      ]);
    }

    const { created, row } = await trackedTenders.track({
      organizationId,
      tenderId,
      status: status ?? 'considering',
      goNoGo: goNoGo ?? null,
      decisionNote: decisionNote ?? null,
      relevance,
    });

    return { created, trackedTender: await TrackedTenderService.detail(organizationId, row.id) };
  }

  static async update(organizationId, id, patch) {
    const current = await trackedTenders.findRow(id, organizationId);
    if (!current) throw ApiError.notFound('Tracked tender');

    const next = {};

    if (patch.status !== undefined && patch.status !== current.status) {
      const allowed = TRANSITIONS[current.status] ?? [];
      if (!allowed.includes(patch.status)) {
        throw ApiError.conflict(
          `A tracked tender cannot move from "${current.status}" to "${patch.status}".`,
          { from: current.status, to: patch.status, allowed }
        );
      }

      /**
       * `submitted` is reached by submitting the bid, not by asserting the
       * status. Otherwise the board could say "submitted" with no locked
       * snapshot behind it, and the record of what was offered — the thing the
       * whole table exists to hold — would be missing exactly when it matters.
       */
      if (patch.status === 'submitted') {
        throw ApiError.conflict(
          'Submit the bid to reach "submitted" — POST /tracked-tenders/:id/bid/submit.',
          { from: current.status, to: patch.status }
        );
      }

      next.status = patch.status;
    }

    if (patch.goNoGo !== undefined) next.go_no_go = patch.goNoGo;
    if (patch.decisionNote !== undefined) next.decision_note = patch.decisionNote;

    if (!Object.keys(next).length) return TrackedTenderService.detail(organizationId, id);

    const updated = await trackedTenders.update(id, organizationId, next);
    if (!updated) throw ApiError.notFound('Tracked tender');
    return TrackedTenderService.detail(organizationId, id);
  }

  /**
   * Stop tracking entirely.
   *
   * Refused once a bid is locked: `bids` cascades on delete, so this would
   * destroy the submitted snapshot — and a submitted bid is a record, not a
   * draft. `dropped` is the status for walking away with the history intact.
   */
  static async remove(organizationId, id) {
    const bid = await bids.findForOrg(id, organizationId);
    if (bid?.locked) {
      throw ApiError.conflict(
        'This pursuit has a submitted bid and cannot be deleted. Set its status to "dropped" instead.',
        { bidId: bid.id }
      );
    }

    const deleted = await trackedTenders.remove(id, organizationId);
    if (!deleted) throw ApiError.notFound('Tracked tender');
    return { deleted: true };
  }

  // --- bids ---------------------------------------------------------------

  /**
   * Create or update the draft bid.
   *
   * Refuses once locked, and says so with 409 rather than silently ignoring
   * the write — a supplier who believes they changed their price and did not
   * is worse off than one who is told they cannot.
   */
  static async saveBid(organizationId, trackedTenderId, input) {
    const tracked = await trackedTenders.findRow(trackedTenderId, organizationId);
    if (!tracked) throw ApiError.notFound('Tracked tender');

    const existing = await bids.findForOrg(trackedTenderId, organizationId);
    if (existing?.locked) {
      throw ApiError.conflict('This bid was submitted and is now a read-only snapshot.', {
        submittedAt: existing.submitted_at,
      });
    }

    await bids.upsertDraft({
      trackedTenderId,
      organizationId,
      price: input.price,
      lotNumber: input.lotNumber,
      currency: input.currency,
      notes: input.notes,
    });

    /**
     * Drafting a price is the act that moves a pursuit out of "considering" —
     * inferred rather than asked for, because making the user set a status
     * they have already demonstrated is busywork the board would then get
     * wrong whenever they skipped it.
     */
    if (tracked.status === 'considering') {
      await trackedTenders.update(trackedTenderId, organizationId, { status: 'preparing' });
    }

    return TrackedTenderService.detail(organizationId, trackedTenderId);
  }

  /**
   * Lock the bid and advance the pipeline.
   *
   * Both writes must land together — a locked bid on a pursuit still reading
   * "preparing", or a "submitted" pursuit with an unlocked bid, are each a
   * board that lies about the same fact.
   */
  static async submitBid(organizationId, trackedTenderId, { submittedAt } = {}) {
    const tracked = await trackedTenders.findRow(trackedTenderId, organizationId);
    if (!tracked) throw ApiError.notFound('Tracked tender');

    const bid = await bids.findForOrg(trackedTenderId, organizationId);
    if (!bid) throw ApiError.notFound('Bid');

    if (bid.locked) {
      throw ApiError.conflict('This bid has already been submitted.', { submittedAt: bid.submitted_at });
    }

    /**
     * A submitted snapshot with no price records nothing. Better to refuse
     * than to lock an empty row that can never be corrected.
     */
    if (bid.price === null || bid.price === undefined) {
      throw ApiError.conflict('A bid needs a price before it can be submitted.');
    }

    const locked = await bids.submit(bid.id, organizationId, { submittedAt: submittedAt ?? new Date() });

    // Lost the race with a concurrent submit — the UPDATE's `locked = false`
    // guard matched nothing, which means somebody else got there first.
    if (!locked) throw ApiError.conflict('This bid has already been submitted.');

    await trackedTenders.update(trackedTenderId, organizationId, { status: 'submitted' });

    /**
     * Try to resolve immediately: a bid entered after the fact on an already
     * settled tender has its answer waiting in the ledger right now. Best
     * effort — an unsettled tender simply returns null and the reconcile job
     * picks it up whenever it settles.
     */
    const resolved = await BidOutcomeService.resolveOne(locked, {
      tenderId: tracked.tender_id,
      organizationId,
    });

    if (resolved?.outcome === 'won' || resolved?.outcome === 'lost') {
      await trackedTenders.update(trackedTenderId, organizationId, { status: resolved.outcome });
    }

    return TrackedTenderService.detail(organizationId, trackedTenderId);
  }

  static async removeBid(organizationId, trackedTenderId) {
    const bid = await bids.findForOrg(trackedTenderId, organizationId);
    if (!bid) throw ApiError.notFound('Bid');
    if (bid.locked) {
      throw ApiError.conflict('A submitted bid cannot be deleted.', { submittedAt: bid.submitted_at });
    }
    await bids.remove(bid.id, organizationId);
    return { deleted: true };
  }

  /**
   * Own-bid performance: wins, losses, and how far off the losses were.
   *
   * Reported alongside the count it is drawn from, and never as a bare
   * percentage. The same honesty rule the benchmark layer runs on applies to a
   * tenant's own numbers: two bids is not a win rate.
   */
  static async performance(organizationId) {
    const summary = await bids.outcomeSummary(organizationId);
    const decided = summary.won + summary.lost;

    /**
     * The same threshold the benchmark layer runs on, applied to the tenant's
     * own numbers.
     *
     * One decided bid produces a win rate of exactly 0% or exactly 100%, and
     * both are noise wearing a percentage sign. `insufficient_data` is the
     * honest answer, and it is the answer this codebase already gives for
     * public benchmarks — a customer's own dashboard is not the place to make
     * an exception, because it is the number they would repeat out loud.
     *
     * The raw counts are still returned. "1 win, 0 losses" is true and useful;
     * "100% win rate" is neither.
     */
    const enough = decided >= config.INTELLIGENCE.MIN_COMPARABLES;

    return {
      ...summary,
      decided,
      winRate: enough ? summary.won / decided : null,
      avgGapWhenLost: enough ? summary.avgGapWhenLost : null,
      minimumForRates: config.INTELLIGENCE.MIN_COMPARABLES,
      basis: enough ? 'own_submitted_bids' : 'insufficient_data',
    };
  }

  // --- supplier identity --------------------------------------------------

  /**
   * The party this organisation bids as — the link that makes auto win/loss
   * possible at all. Read and write live here rather than in an org-settings
   * feature because this is the only thing that consumes them today.
   */
  static async supplierIdentity(organizationId) {
    const row = await organizations.supplierPartyFor(organizationId);
    return {
      supplierPartyId: row?.supplier_party_id ?? null,
      name: row?.supplier_name ?? null,
      taxId: row?.supplier_tax_id ?? null,
    };
  }

  /**
   * Candidate parties for the claim above. Ranked by how often they actually
   * appear in the bid ledger, since a trading name is rarely unique.
   */
  static async supplierCandidates(query) {
    const rows = await parties.searchSuppliers({ query });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      taxId: row.tax_id,
      region: row.region,
      bidCount: Number(row.bid_count),
    }));
  }

  static async setSupplierIdentity(organizationId, { supplierPartyId }) {
    if (supplierPartyId !== null) {
      const party = await parties.findById(supplierPartyId);
      if (!party) throw ApiError.notFound('Party');
    }

    try {
      await organizations.setSupplierParty(organizationId, supplierPartyId);
    } catch (error) {
      // The partial unique index: this party is already claimed by another org.
      if (error?.code === '23505') {
        throw ApiError.conflict('That supplier is already claimed by another organization.');
      }
      throw error;
    }

    return TrackedTenderService.supplierIdentity(organizationId);
  }
}
