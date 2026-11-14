# 06 — Switch it on: the gate

**What to build:** The decision to let customers' alerts read inferred codes, made on numbers.
The backtest runs with the owner's hand-labelled paper lots included. A method and a confidence
threshold are chosen. The flag is switched on only if the chosen method agrees with the buyer's
division on at least 90% of lots **for each purchase kind**. Then one real biddable paper tender
is followed from ingest to alert. This is the one ticket that needs the owner: labelling the
lots and the final yes. See `.scratch/cpv-inference/spec.md`, *Backtest*, and ADR 0006.

**Blocked by:** 03 — The model picks among the candidates; 05 — Inferred codes reach matching,
filters and relevance, behind the gate.

**Status:** ready-for-agent

- [ ] If the owner has labelled rows in `paper-lots.csv`, they are included in the run; if not,
      that is recorded, and services and works are judged on what exists.
- [ ] `npm run cpv:backtest` is re-run **through the real API** (ticket 03's numbers are an
      offline approximation through Claude Code subagents), for both methods across a range of
      confidence thresholds, with the system prompt both with and without the division/group
      list. The table (per purchase kind and source: full code, group, division, none share;
      model cost: tokens and cache reads) is recorded in this ticket.
- [ ] The method, threshold and prompt variant are chosen and set in config, with the reason.
- [ ] Each purchase kind is judged on its **honest** measure: goods on e-auction and labelled
      paper lots, never on ARMEPS alone, whose lot names copy the classifier's wording (ticket
      02 found this for goods, and ticket 03's 100% on ARMEPS services is the same effect);
      services and works only on labelled paper lots, or on enough ARMEPS lots whose names do
      not match a classifier name verbatim. A kind with no honest measure is not opened.
- [ ] `CPV_INFERENCE_READ_KINDS` lists exactly the kinds whose honest measure reaches ≥90%
      division agreement; every other kind stays out, and its shortfall and the next step are
      recorded here. Lowering the bar is the owner's decision, never the agent's.
- [ ] Before the list is filled, `npm run cpv:reinfer` (new; dry run by default, `--apply` to
      write) re-codes biddable tenders' lots with the chosen method: lots coded by another
      method (ticket 04 coded with `nearest`, e.g. «Հելիում գազ» → 33141212 and «Ազոտ» → a
      fertiliser) and lots unclassified for a transient reason (`rate_limited`,
      `ai_unavailable`) or by another method. It reports what it would change, touches no
      stated code, never moves `version`, and queues the re-match only for kinds in the list.
      Transient-unclassified lots are also retried on their tender's next document write.
- [ ] With the flag on, one real biddable paper tender ingested live gets inferred codes, and a
      saved search on one of them alerts once, marked "(inferred CPV)".
- [ ] Separately, `npm run documents:backfill` for e-auction has been run, and how many of the
      385 closed e-auctions recovered their stated codes is recorded here.
