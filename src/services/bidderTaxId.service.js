import parties from '../repositories/party.repo.js';
import publicBids from '../repositories/publicBid.repo.js';

/**
 * The ՀՎՀՀ PPCM states for an e-auction's bidders, onto the parties
 * eauction's own ledger made of them (ticket 11, ADR 0004: *for e-auctions
 * PPCM adds only the bidder's ՀՎՀՀ*). Nothing else of PPCM's is written for an
 * e-auction — no bid, no award, no status, no rank, no rejection: eauction's
 * ledger is the authority there, and PPCM's rejected flag disagreed with it in
 * 28 of 95 rows (research.md).
 *
 * The join is structural, never a name: tender (resolution's rule 3), lot
 * number and **exact** net offer — PPCM's `participant_total_price` equalled
 * the ledger's `final_offer_net` on 95 of 95 rows. A PPCM bidder attaches only
 * when its (lot, net) is one bidder on PPCM's side and one bid on ours.
 */

/** Amounts compare in cents: PPCM's are floats, the ledger's numeric strings. */
const cents = (value) => {
  const n = Number(value);
  return value === null || value === undefined || !Number.isFinite(n) ? null : Math.round(n * 100);
};

const keyOf = (lotNumber, net) => `${Number(lotNumber)}|${cents(net)}`;

/**
 * PPCM's bidders of one procedure × one tender's ledger → which party gains
 * which ՀՎՀՀ, and every bidder that gains none, counted by why. Pure.
 *
 * - `bidders`: `[{ lotNumber, taxId, name, net }]` (ppcm/observation.js#biddersOf).
 * - `offers`: `[{ lot_number, final_offer_net, supplier_id, tax_id }]`, the
 *   tender's eauction bids with their party's ՀՎՀՀ.
 *
 * Every PPCM bidder lands in exactly one count:
 *
 * - `toAttach` — the one bid of its lot and net, on a party with no ՀՎՀՀ;
 * - `already` — that party already holds this ՀՎՀՀ;
 * - `unmatched.no_tax_id` — PPCM states none (a foreign bidder);
 * - `unmatched.ambiguous` — two PPCM bidders at one lot and net;
 * - `unmatched.no_bid` — no bid of ours at that lot and exact net;
 * - `unmatched.several_bids` — two bids of ours at it (a tie);
 * - `unmatched.conflicting` — one party matched to two ՀՎՀՀ in this answer;
 * - `unmatched.holds_other` — the party already holds a different ՀՎՀՀ,
 *   which is never overwritten.
 */
export const matchTaxIds = (bidders = [], offers = []) => {
  const unmatched = { no_tax_id: 0, ambiguous: 0, no_bid: 0, several_bids: 0, conflicting: 0, holds_other: 0 };

  const ppcm = new Map();
  for (const bidder of bidders) {
    const key = keyOf(bidder.lotNumber, bidder.net);
    if (!ppcm.has(key)) ppcm.set(key, []);
    ppcm.get(key).push(bidder);
  }
  const ours = new Map();
  for (const offer of offers) {
    if (cents(offer.final_offer_net) === null) continue;
    const key = keyOf(offer.lot_number, offer.final_offer_net);
    if (!ours.has(key)) ours.set(key, []);
    ours.get(key).push(offer);
  }

  const proposals = [];
  for (const [key, entries] of ppcm) {
    const distinct = new Set(entries.map((entry) => entry.taxId ?? `name:${entry.name}`));
    if (distinct.size > 1) {
      unmatched.ambiguous += entries.length;
      continue;
    }
    const [bidder] = entries;
    if (!bidder.taxId) {
      unmatched.no_tax_id += 1;
      continue;
    }
    const bids = ours.get(key) ?? [];
    if (bids.length === 0) unmatched.no_bid += 1;
    else if (bids.length > 1) unmatched.several_bids += 1;
    else proposals.push({ supplierId: bids[0].supplier_id, taxId: bidder.taxId, held: bids[0].tax_id ?? null });
  }

  // A party is one company: two ՀՎՀՀ for it in one answer means one of the
  // joins is wrong, and nothing says which.
  const perParty = new Map();
  for (const proposal of proposals) {
    if (!perParty.has(proposal.supplierId)) perParty.set(proposal.supplierId, new Set());
    perParty.get(proposal.supplierId).add(proposal.taxId);
  }

  const toAttach = new Map();
  let already = 0;
  for (const proposal of proposals) {
    if (perParty.get(proposal.supplierId).size > 1) unmatched.conflicting += 1;
    else if (proposal.held === proposal.taxId) already += 1;
    else if (proposal.held) unmatched.holds_other += 1;
    else toAttach.set(proposal.supplierId, proposal.taxId);
  }

  return {
    bidders: bidders.length,
    toAttach: [...toAttach.entries()].map(([supplierId, taxId]) => ({ supplierId, taxId })),
    // A party that bid on several lots is matched once per lot.
    matchedRows: proposals.length - unmatched.conflicting - unmatched.holds_other,
    already,
    unmatched,
  };
};

export default class BidderTaxIdService {
  /**
   * Give the bidders of `tenderId`'s eauction ledger the ՀՎՀՀ PPCM's
   * `observation` states for them. Fills blanks only (`setTaxId`), so a
   * repeat of the same answer writes nothing.
   *
   * A ՀՎՀՀ that, once attached, two parties hold — the same company under
   * two eauction business-operator ids, or an e-auction party and the
   * `ppcm:bo:{ՀՎՀՀ}` party an ARMEPS ledger made before — is returned in
   * `shared`, to be reported, and never merged.
   */
  static async attach({ observation, tenderId }) {
    const offers = await publicBids.netOffersForTender(tenderId, 'eauction');
    const match = matchTaxIds(observation.bidders, offers);

    let attached = 0;
    const shared = [];
    for (const { supplierId, taxId } of match.toAttach) {
      // False only if the party gained a ՀՎՀՀ since it was read.
      if (!(await parties.setTaxId(supplierId, taxId))) continue;
      attached += 1;
      const holders = await parties.holdersOfTaxId(taxId);
      if (holders.length > 1) shared.push({ taxId, partyIds: holders.map((holder) => holder.id) });
    }

    return {
      bidders: match.bidders,
      matchedRows: match.matchedRows,
      attached,
      already: match.already,
      unmatched: match.unmatched,
      shared,
    };
  }
}
