import bids from '../repositories/bid.repo.js';
import publicBids from '../repositories/publicBid.repo.js';
import organizations from '../repositories/organization.repo.js';
import { logger } from '../utils/logger.js';

/**
 * Resolve a customer's own bid against the public record.
 *
 * This is the payoff of building `bids` before any screen exists. The corpus
 * already holds 65,000 public bids and 17,000 awards; the moment a tenant
 * stores their OWN submitted price next to that, every settled tender answers
 * a question nobody else can: how far off were we, and from whom.
 *
 * Three rules govern the resolution, all of them variants of "never fabricate":
 *
 *   1. **A win comes from `awards`, never from `rank = 1`.** The source ranks
 *      rejected submissions too (`Մերժված`). Reading rank alone once attributed
 *      21% of awards to companies the buyer had thrown out.
 *   2. **Absence from the ledger is `not_found`, not `lost`.** It means either
 *      the bid was never actually submitted or the ledger is not published yet.
 *      Recording a defeat that may not have happened would poison the win rate
 *      the customer is paying for.
 *   3. **The winning price is copied, not joined.** `public_tender_bids` is
 *      replaced wholesale on every re-normalize, so a stored "we lost by 4%"
 *      must not move because a parser improved two months later.
 */

/**
 * Which lot's result answers for this bid.
 *
 * A bid carries an optional `lot_number` because a multi-lot procurement can be
 * won and lost simultaneously. With one stated, that lot decides. With none —
 * the common case, since most e-auctions here are single-lot — any won lot
 * makes it a win, which is the reading a supplier would give it themselves.
 */
const selectEntries = (entries, lotNumber) =>
  lotNumber === null || lotNumber === undefined
    ? entries
    : entries.filter((e) => e.lot_number === lotNumber);

const money = (value) => (value === null || value === undefined ? null : Number(value));

export default class BidOutcomeService {
  /**
   * Decide one bid's outcome without writing it.
   *
   * Split from `resolve` so the same logic can answer a read ("what would this
   * say?") without a side effect, and so it is testable with plain rows.
   */
  static decide(entries, lotNumber) {
    const scoped = selectEntries(entries, lotNumber);
    if (!scoped.length) return { outcome: 'not_found', winningPrice: null };

    const won = scoped.find((e) => e.is_winner === true);
    // Without VAT: `bids.price` is the auction value the organisation entered,
    // and the stored gap compares the two.
    if (won) return { outcome: 'won', winningPrice: money(won.award_net_amount ?? won.final_offer_net) };

    /**
     * We bid and did not win. The winning price is the award amount on the lot
     * we actually competed for — read off our own ledger rows, which carry the
     * award join, so a multi-lot tender reports the lot we lost rather than
     * whichever lot happened to be cheapest.
     */
    const withAward = scoped.find((e) => e.award_net_amount !== null && e.award_net_amount !== undefined);
    return { outcome: 'lost', winningPrice: money(withAward?.award_net_amount ?? null) };
  }

  /**
   * Resolve every submitted bid whose tender has settled.
   *
   * Driven from the database rather than from an event, for the same reason
   * `tender.refresh` exists: a tender settles long after the bid was
   * submitted, and the settling happens in a worker that knows nothing about
   * which tenants were bidding.
   */
  static async reconcile({ limit = 200 } = {}) {
    const pending = await bids.unresolved({ limit });
    if (!pending.length) return { checked: 0, resolved: 0, notFound: 0 };

    /**
     * One org's identity is read once, not once per bid — the worklist is
     * ordered by submission time and a single tenant's backlog would otherwise
     * repeat the same lookup for every row in it.
     */
    const identityCache = new Map();
    const identityFor = async (organizationId) => {
      if (!identityCache.has(organizationId)) {
        identityCache.set(organizationId, await organizations.supplierPartyFor(organizationId));
      }
      return identityCache.get(organizationId);
    };

    let resolved = 0;
    let notFound = 0;
    let unclaimed = 0;

    for (const bid of pending) {
      const identity = await identityFor(bid.organization_id);

      /**
       * No claimed supplier party means no way to find them in the ledger, and
       * writing `not_found` would be a lie about the tender rather than a fact
       * about the account. Left unresolved so it resolves itself the day they
       * claim an identity.
       */
      if (!identity?.supplier_party_id) {
        unclaimed += 1;
        continue;
      }

      const entries = await publicBids.supplierEntriesForTender(bid.tender_id, identity.supplier_party_id);
      const { outcome, winningPrice } = BidOutcomeService.decide(entries, bid.lot_number);

      /**
       * A cancelled tender has no winner to be absent from, so `not_found`
       * there is the permanent truth. On an awarded tender it may just be a
       * ledger that has not been published yet, and re-checking costs one
       * indexed lookup — so leave it unresolved and let the next sweep try.
       */
      if (outcome === 'not_found' && bid.tender_status !== 'cancelled') {
        notFound += 1;
        continue;
      }

      await bids.recordOutcome(bid.id, { outcome, winningPrice });
      resolved += 1;
    }

    logger.info(
      `[bids] reconcile: ${pending.length} checked, ${resolved} resolved, ` +
        `${notFound} awaiting ledger, ${unclaimed} without a claimed supplier party`
    );

    return { checked: pending.length, resolved, notFound, unclaimed };
  }

  /**
   * The same resolution for one bid, on demand.
   *
   * Returns `null` rather than throwing when there is nothing to say — the
   * caller is a read path and an unsettled tender is the normal case, not an
   * error.
   */
  static async resolveOne(bid, { tenderId, organizationId }) {
    const identity = await organizations.supplierPartyFor(organizationId);
    if (!identity?.supplier_party_id) return null;

    const entries = await publicBids.supplierEntriesForTender(tenderId, identity.supplier_party_id);
    if (!entries.length) return null;

    const { outcome, winningPrice } = BidOutcomeService.decide(entries, bid.lot_number);
    return bids.recordOutcome(bid.id, { outcome, winningPrice });
  }
}
