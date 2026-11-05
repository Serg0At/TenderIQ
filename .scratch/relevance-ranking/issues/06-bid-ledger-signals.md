# 06 — Rank on what the supplier actually bids on

**What to build:** The ranking stops relying on what a supplier typed and starts reading what they
did. A medical consumables supplier who has never configured a saved search opens the list and
finds their categories at the top, because the public bid ledger already records forty tenders
they bid on and six they won.

Three signals, strongest first: a category they have **won** in — strongest of all at the same
buyer; a category they have **bid** in; and a **buyer they are known at**, even when the category
is new. Signals add with diminishing returns, so a tender matching several beats one matching a
single strong signal.

A **loss does not count against a tender.** Losing a category means competing in it, which is
relevance; whether they can win it is the intelligence layer's separate question. Burying the
categories a supplier fights hardest in would be exactly backwards.

Old history fades rather than disappearing: full weight recently, less further back, in steps so a
ranking can be reproduced by hand. The boundary is one configuration value, because ticket 11's
backtest will sweep it rather than anyone guessing — suppliers bid rarely here, so a short window
starves the signal instead of sharpening it.

This needs the organization's **supplier identity**, the human-claimed party it bids as. Without
it there is no way to ask "did we bid on this", so an organization that has not claimed one keeps
ranking on the signals from ticket 05, with the absence reported in the missing-signals list
rather than silently ignored.

Expect this to look weak against today's two months of data — the median supplier in the ledger
has bid on one tender. That is a data problem, resolved in ticket 10, not a reason to re-tune.

**Blocked by:** 05.

**Status:** done

- [x] A tender in a category the organization has won in ranks above one in a category it has only
      bid in, which ranks above one at a merely familiar buyer.
- [x] Winning at the same buyer in the same category is the strongest single signal available.
- [x] A loss never lowers a tender's rank.
- [x] Category closeness uses the shared CPV rule from ticket 04, so an exact code counts for more
      than a shared division.
- [x] Recent history outweighs old history, in steps, with the boundary held in configuration and
      used nowhere else by hard-coded literal.
- [x] History is never discarded by age — an old bid counts less, not zero.
- [x] Reasons name the evidence and its scale, enough for a client to write "you won 3 lots at
      this buyer" without inventing anything.
- [x] An organization with no supplier identity still receives a ranking from its other signals,
      and the response names the missing identity.
- [x] Participation counts include rejected bids and money statistics exclude them, matching the
      two counting rules the profile and public-bid repositories already follow.
- [x] Reading a tenant's ranking never exposes another tenant's private data; every ledger signal
      is drawn from public award and bid records only.
- [x] Still inside the 1.5s P95 budget with the ledger queries added.

> P95 not yet measured where it counts: ~20 ms server-side execution and ~2 ms ranking, but
> wall-clock from a development machine to Neon us-east-2 was 3–9 s, all network. Measure from
> the deployed API before ticking.

> 2026-10-31: p95 884 ms through the full API on the local Postgres, ledger signals included,
> with a 3,305-lot identity. Inside budget today. The ledger *scoring* is what costs (≈600 ms of
> it), not the ledger queries, and it scales with ledger size. Details in ticket 05.

> 2026-11-05: ledger scoring reworked to per-code totals, output unchanged; p95 181 ms through
> the full API with the same identity, and 69 ms of scoring on a 15× synthetic ledger. Details
> in ticket 05.
