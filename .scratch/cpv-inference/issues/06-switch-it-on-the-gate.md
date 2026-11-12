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

- [ ] If ticket 02's script asked for it, the owner's labelled paper-lot file is in place and
      included in the run.
- [ ] `npm run cpv:backtest` is run for both methods across a range of confidence thresholds; the
      table (per purchase kind: full code, group, division, none share; model cost) is recorded
      in this ticket.
- [ ] The method and threshold are chosen and set in config, with the reason recorded here.
- [ ] If every purchase kind reaches ≥90% division agreement, the flag is switched on. If any
      does not, the flag stays off, and the shortfall and the next step are recorded here.
      Lowering the gate is the owner's decision, never the agent's.
- [ ] With the flag on, one real biddable paper tender ingested live gets inferred codes, and a
      saved search on one of them alerts once, marked "(inferred CPV)".
- [ ] Separately, `npm run documents:backfill` for e-auction has been run, and how many of the
      385 closed e-auctions recovered their stated codes is recorded here.
