# 32 — An organization is one bidder across all three submission channels

**What to build:** An organization that claims its supplier identity gets win/loss reconciliation
on e-auction, ARMEPS **and** paper bids, not only on the channel where its claimed party came
from. Found in ticket 08: a paper bidder is keyed by name, so it is a different party from the
same company's e-auction party, and `organizations.supplier_party_id` holds one party.

**Blocked by:** 11, 19

**Status:** ready-for-agent

Decided 2026-10-23. Never match a party on name (CLAUDE.md, *supplier identity*), and prefer the
ՀՎՀՀ, the only structural identifier there is:

- [ ] **First, merge by ՀՎՀՀ.**
  - Check whether the 323-Ա contract notice states the winner's or each bidder's ՀՎՀՀ (the template
    names a «Ընտրված մասնակից»; record what it carries). If it does, paper parties get it, and
    ticket 11's "ՀՎՀՀ first" party resolution merges them with the e-auction and PPCM party of
    the same company.
  - Record how many paper parties merge.
- [ ] **Then, for parties with no ՀՎՀՀ anywhere, an organization may claim more than one party,**
      each as a separate deliberate human claim from a search, exactly as the single claim works
      today.
  - The claim becomes a set (for example, a `supplier_identities` table keyed by organization
    and party, with the private-table rules: `organization_id` on the row, composite foreign
    keys where they apply).
  - `supplier_party_id` is migrated into it.
  - Reconciliation, win rate and "did we win" read the set.
- [ ] A party can be claimed by at most one organization, as today. Record whether that holds now,
      and keep it.
- [ ] `/organization/supplier-identity` lists, adds and removes claims. The API reference is
      updated.
- [ ] Win rate still obeys `INTELLIGENCE.MIN_COMPARABLES` over the union of claimed parties.
- [ ] If you add a migration, add it to ticket 30's list.
