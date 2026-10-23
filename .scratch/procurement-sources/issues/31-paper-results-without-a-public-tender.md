# 31 — Paper results of procedures that were never announced publicly

**What to build:** The prices in gnumner's contract-concluded notices reach intelligence even when
the procedure was never announced on gnumner. That covers most quotations, which are sent straight
to invited suppliers, and every single-source procedure. A notice like that is **not** counted as
"Tendra missed a tender", because there was nothing public to miss. Found in ticket 08: about 780
notices, only one of which belonged to a published quotation.

**Blocked by:** None. Ticket 08 is done.

**Status:** ready-for-agent

**Decided 2026-10-23, an amendment to ADR 0004.** The ADR's rule is that "in live mode, result
sources never create tenders", and its one exception is the PPCM history backfill: results whose
tender no discovery source will ever show. These notices are the same case, live. Under the
current rule, about 99% of paper price data is thrown away. Worse, it is recorded as
`no_candidate`, which the planned operator alert reads as a coverage failure, so the real misses
would drown in the noise.

- [ ] **Tell "never public" from "missed", from facts, not guesses.**
  - If the notice's invitation date falls inside the window the gnumner sweeps fully cover, and no
    gnumner invitation with that code and buyer was ever seen, the procedure was **not public**.
  - A single-source procedure (its procedure type, from the code or the template) is never public.
  - Outside the covered window, it is unknown: keep it `no_candidate` as now.
  - Record how the covered window is computed (watermarks plus the cold-start depth).
- [ ] A not-public notice creates a **result-only tender**:
  - `submission_channel = 'paper'`, the procedure type from the notice, status `awarded`;
  - a `gnumner` link with role `results`, buyer, code, the bids and awards from the parser;
  - **never biddable** and never alerted: no `match.tender` job, ever.

  It is the same shape as a PPCM-history tender.
- [ ] **Single-source results are kept out of competitive comparisons.** A single-source price is
      what a buyer agreed with one supplier, not what a market bid. Competitor prices and
      benchmarks exclude `procedure_type = 'single_source'` unless asked for explicitly. Record
      how the benchmark tiers treat it, and that `insufficient_data` still holds.
- [ ] Notices that are genuinely `no_candidate` (inside the covered window, the code was public,
      and Tendra lacks the tender) stay unmatched and counted. Those are the ones the operator
      alert is for.
- [ ] The `unsupported_format` counts can be read **per notice kind** (invitation, amendment,
      contract; single-source vs competitive), so ticket 13's converter decision is not skewed
      by single-source notices (12 of 18 unreadable today).
- [ ] ADR 0004 gets a short amendment naming this second exception. Discovery still never
      receives these tenders: they are absent from `GET /tenders` biddable lists by construction.
- [ ] Re-processing the about 780 stored notices raises no alert. Record how many became
      result-only tenders, how many stay `no_candidate`, and how many stay unknown.
- [ ] If you add a migration, add it to ticket 30's list.
