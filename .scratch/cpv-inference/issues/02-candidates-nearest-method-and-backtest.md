# 02 — Candidates, the no-model method, and the backtest

**What to build:** For any lot, Tendra can list the candidate codes it could carry: codes
Armenian buyers put on similarly named lots, and classifier entries with similar names. It can
also infer a code without a model (`nearest`: the code of the single most similar stated-code
lot above a similarity floor). `npm run cpv:backtest` measures how often that agrees with the
buyer's own code, per purchase kind. This produces the baseline every later method is judged
against. Nothing is written onto real tenders yet. See `.scratch/cpv-inference/spec.md`, *How a
code is chosen*, *The no-model baseline* and *Backtest*.

**Blocked by:** 01 — The CPV classifier is loaded and names every code.

**Status:** ready-for-agent

- [ ] `tender_lots` gains `inferred_cpv_code` (FK to `cpv_classifier`) and its provenance:
      method (`model` | `nearest`), model id (nullable), classifier version and inferred-at.
      A CHECK refuses an inferred code on a lot whose stated code is set. A trigram index on
      `tender_lots.name` is added. All of this goes straight into `create_table.js` /
      `drop_table.js`.
- [ ] A repository returns a lot's candidates: the codes of the most similar stated-code lots
      (with how often each was used) and the most similar classifier names, at most a few dozen,
      each with name and level. A candidate is never drawn from the lot itself.
- [ ] The `nearest` method lives in a pure service that takes candidates and returns a code or
      none.
- [ ] `npm run cpv:backtest` holds out a sample of stated-code lots and reports agreement at
      full code, group (5 digits) and division (2 digits), plus the share answered none, **per
      purchase kind** (goods, works, services). None is reported as coverage, never as wrong.
- [ ] Services and works come from ARMEPS's labelled lots. If either has fewer than ~50, the
      script writes a file of ~50 biddable paper lots (name, tender subject, empty code column)
      for the owner to label. A labelled file passed back in is included in the next run.
- [ ] Verified by hand: the baseline's numbers per purchase kind are recorded in this ticket;
      the CHECK refuses an inferred code beside a stated one; the FK refuses a code outside the
      classifier.
