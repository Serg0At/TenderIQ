# Backtest findings — relevance ranking

**Run:** 2026-10-17, `node src/scripts/backtestRelevance.js` (defaults), against the live
database. **Provisional: run before the archive backfill (ticket 10).** Re-run after it; the
recency question below cannot be answered until then.

## Setup

- Cut-off: the ledger's median bid date, **2026-08-25 05:00Z**.
- Candidates: the **165** tenders biddable at the cut-off (published by it, deadline after it).
  None lacked a CPV code, so the text fallback was not exercised.
- Graded: the **311** suppliers in the public ledger that bid on at least one of them — 824 real
  bids. Each supplier's ranking used only ledger lots whose auction was before the cut-off.
- Production `rankTenders`, unchanged. Ledger signals only: ledger suppliers are not customers,
  so they have no fields, saved searches or pipeline.
- Positions are tie-aware (a bid inside a tie sits at the tie's middle), and every figure is
  shown beside a random order on the same targets.
- "Rankable" = at least 3 ledger lots before the cut-off (160 suppliers); "thin" = fewer
  (151, of whom 116 had none at all). Reported apart, never averaged together.

## Weights as measured

```
WEIGHTS   wonSameBuyer 0.9 · won 0.8 · bid 0.55 · pursued 0.55 · savedSearch 0.4 · field 0.25
          knownBuyer 0.15 · text 0.25 · dropped (penalty) 0.5
CLOSENESS exact 1 · group 0.7 · division 0.4
BANDS     strong ≥ 0.6 · moderate ≥ 0.35 · weak
volume(w) = w / (w + 0.5)    recency: 1 within N months, ½ to 3N, ¼ beyond
```

## Results

| Group | Suppliers | Real bids | In top 10 | In top 20 | Median position | MRR |
|---|---|---|---|---|---|---|
| Rankable (≥ 3 lots) | 160 | 617 | **43.9%** (random 6.1%) | **63.0%** (random 12.1%) | **7.9%** of the list (random 50%) | 0.410 |
| Thin (< 3 lots) | 151 | 207 | 15.9% (random 6.1%) | 20.8% (random 12.1%) | 50.3% (random 50%) | 0.095 |

Identical at a full-weight window of 6, 12 and 24 months.

## Reading

- **For a supplier with history, the ranking works.** Nearly half of what they actually went on
  to bid sits on the first screen of a 165-row list, seven times what a random order manages,
  and the typical real bid is in the top 8%.
- **For a supplier without history, it is close to random — honestly so.** The thin group's
  median position is 50%: with nothing to rank on, the order is mostly ties, and the tie-aware
  placement refuses to give it credit for them. Its top-10 lift comes from the few with one or
  two lots. This is why the live endpoint asks for a field or saved search rather than inventing
  an order, and it is the case those two signals exist for — which this backtest cannot measure,
  since ledger suppliers have neither.
- **The recency window is undecided.** Every lot in the corpus is under three months old, so
  every setting weighs every lot at 1 and the three runs are the same run. 12 months stays the
  default until the backfill gives the sweep something to separate.
- No weight was changed on the strength of this run: two months of ledger is enough to show the
  rule beats random by a wide margin, not enough to tune it.

## Still to do

- Re-run after ticket 10 loads the archive; record the sweep, and whether a longer window lifts
  or drowns the rankable group.
- Record archive CPV coverage then: a low figure would exercise the text fallback here and decide
  whether the one-off AI tagging batch is worth its ~$17–33.
