# 17 — Every CPV a tender states reaches alerts, discovery and relevance

**What to build:** A supplier whose saved search names any CPV code a tender states hears about
that tender, finds it with the CPV filter, and sees it ranked, even when the source does not say
which lot the code belongs to. Found in ticket 05: in tender 12543482, `09211150` is on the armeps.am
page but on neither the tender nor a lot, so a saved search on it misses the tender. A missed
tender is the #1 churn cause.

**Blocked by:** None — can start immediately (ticket 05 is done).

**Status:** ready-for-agent

Today `tenders.cpv_code` holds one code. Lots get a code only where a lot name starts with that
code's label (88 of 92 lots in ticket 05's sample). The matcher reads `cpvCode` plus the lot
codes; the discovery filter and relevance read the lot codes.

- [ ] A tender keeps **every** CPV code its source states, not only the first: a `text[]` column
      beside `cpv_code` (which stays as the primary code, so no reader breaks). Mapping a code to a
      lot stays where it is; an unmapped code is still a fact about the tender.
- [ ] armeps.am writes all its codes. e-auction writes the codes from its invitation archive.
      Paper writes whatever its invitation states (ticket 06), or nothing.
- [ ] The matcher, the discovery CPV filter and relevance read tender codes ∪ lot codes, each
      through the one CPV rule in `libs/cpv.js`. No reader keeps its own list.
- [ ] Relevance weights and `MATCH_THRESHOLD` are unchanged. Only the set of codes considered grows.
      Re-run `relevance:backtest` and record the before and after top-10 rate. A drop is a finding
      to raise, not to tune away here.
- [ ] Schema change through the four-step workflow. Existing tenders are backfilled from their
      stored payloads (armeps.am pages, e-auction invitation archives), not re-crawled.
- [ ] Verified: a saved search on `09211150` matches 12543482. Record how many tenders gained codes
      and how many new matches the backfill would raise, before any alert job is allowed to fire
      (a backfill must not alert on old tenders).
