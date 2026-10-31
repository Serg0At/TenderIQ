# Backtest findings — relevance ranking

**Run:** 2026-10-17, `node src/scripts/backtestRelevance.js` (defaults), against the live
database. **Provisional: run before the archive backfill (ticket 10).** Re-run after it; the
recency question below cannot be answered until then.

## Setup

- Cut-off: the ledger's median bid date, **2026-08-25 05:00Z**.
- Candidates: the **165** tenders biddable at the cut-off (published by it, deadline after it).
  None lacked a CPV code, so the text fallback was not exercised.
- Graded: the **311** suppliers in the public ledger that bid on at least one of them — 824 real
  bids. Each supplier's ranking used only ledger lots auctioned at least **7 days before** the
  cut-off (`--lag-days`): a lot's ledger and award are published after its auction, so a lot
  auctioned the day before the cut-off was not yet known on it.
- Production `rankTenders`, unchanged. Ledger signals only: ledger suppliers are not customers,
  so they have no fields, saved searches or pipeline.
- Positions are tie-aware (a bid inside a tie sits at the tie's middle), and every figure is
  shown beside a random order on the same targets.
- "Rankable" = at least 3 ledger lots before that (129 suppliers); "thin" = fewer
  (182, of whom 148 had none at all). Reported apart, never averaged together.

## Weights as measured

```
WEIGHTS   wonSameBuyer 0.9 · won 0.8 · bid 0.55 · pursued 0.55 · savedSearch 0.33 · field 0.25
          knownBuyer 0.15 · text 0.25 · dropped (penalty) 0.5
CLOSENESS exact 1 · group 0.7 · division 0.4
BANDS     strong ≥ 0.6 · moderate ≥ 0.35 · weak
volume(w) = w / (w + 0.5)    recency: 1 within N months, ½ to 3N, ¼ beyond
```

## Results

| Group | Suppliers | Real bids | In top 10 | In top 20 | Median position | MRR |
|---|---|---|---|---|---|---|
| Rankable (≥ 3 lots) | 129 | 555 | **36.9%** (random 6.1%) | **58.0%** (random 12.1%) | **9.1%** of the list (random 50%) | 0.368 |
| Thin (< 3 lots) | 182 | 269 | 13.8% (random 6.1%) | 19.0% (random 12.1%) | 50.3% (random 50%) | 0.073 |

(A first run without the publication lag read 43.9% / 63.0% / 7.9% for 160 rankable suppliers —
the difference is what a week of leaked results was worth.)

Identical at a full-weight window of 6, 12 and 24 months.

## Reading

- **For a supplier with history, the ranking works.** Over a third of what they actually went on
  to bid sits in the top 10 of a 165-row list, six times what a random order manages, and the
  typical real bid is in the top 9%.
- **For a supplier without history, it is close to random — honestly so.** The thin group's
  median position is 50%: with nothing to rank on, the order is mostly ties, and the tie-aware
  placement refuses to give it credit for them. Its top-10 lift comes from the few with one or
  two lots. This is why the live endpoint asks for a field or saved search rather than inventing
  an order, and it is the case those two signals exist for — which this backtest cannot measure,
  since ledger suppliers have neither.
- **The recency window is undecided by data.** Every lot in the corpus is under three months old,
  so every setting weighs every lot at 1 and the three runs are the same run. On 2026-10-18 the
  default moved 12 → **24 months** by reasoning instead: buyers procure on a yearly budget, so a
  supplier's bid on last year's round of a tender is the best evidence for this year's round, and
  12 halved it exactly then. Re-check with the sweep once the archive is loaded.
- The saved-search weight was lowered 0.4 → 0.33 in review, not on this run's evidence: the
  spec ranks a typed claim below the bid record, and 0.4 put one covering search above a single
  recent exact bid. The backtest does not exercise saved searches. Otherwise no weight was
  changed on the strength of this run: two months of ledger is enough to show the
  rule beats random by a wide margin, not enough to tune it.

## Second run — 2026-10-18, fresh live import

Same script and weights, against a new live import of the board (1,135 tenders published
2026-08-12 → 2026-10-17, 19,594 bids, party names corrected). Default cut-off 2026-09-18, history
up to 2026-09-11 (7-day lag), 174 tenders biddable then, 324 suppliers graded.

| Group | Suppliers | Real bids | In top 10 | In top 20 | Median position | MRR |
|---|---|---|---|---|---|---|
| Rankable (≥ 3 lots) | 132 | 472 | **40.7%** (random 5.7%) | **65.9%** (random 11.5%) | **8.0%** (random 50%) | 0.353 |
| Thin (< 3 lots) | 192 | 302 | 9.9% (random 5.7%) | 17.5% (random 11.5%) | 50.3% (random 50%) | 0.072 |

The first run's reading holds on a different window: about seven times random for suppliers with
history, near random without. The 6/12/24-month sweep is again identical — two months of history
cannot separate the windows.

The live endpoint was also checked at today's date on this import: all 267 biddable tenders
returned over 6 pages with no repeat or gap, ordering held, nothing non-biddable leaked in, ~107 ms
a page through the full API on a local Postgres, and the top rows' `won_category` counts matched
the ledger exactly.

## Third run — 2026-10-31, local live import

Same script and weights (24-month default), against the live import on the local Postgres:
1,655 tenders published 2026-07-21 → 2026-10-30 (1,514 e-auction, 79 ARMEPS, 62 paper),
28,860 ledger bids on 1,063 tenders, 886 suppliers. This is the live sweep's cold start
plus three months of sweeping — **not** the archive: the backfill has no checkpoint in Redis and
the e-auction tids run 46570 → 48556 only. Default cut-off 2026-09-28, history up to 2026-09-21,
163 tenders biddable then (7 with no CPV, so the text fallback ran for the first time), 313
suppliers graded.

| Group | Suppliers | Real bids | In top 10 | In top 20 | Median position | MRR |
|---|---|---|---|---|---|---|
| Rankable (≥ 3 lots) | 168 | 585 | **46.0%** (random 6.1%) | **69.4%** (random 12.3%) | **7.1%** (random 50%) | 0.385 |
| Thin (< 3 lots) | 145 | 200 | 15.5% (random 6.1%) | 21.5% (random 12.3%) | 50.3% (random 50%) | 0.119 |

The lift holds and grows with depth: about 7.5× random for suppliers with history, and the
rankable group is up from 129 to 168 because a month more of ledger lies behind the cut-off. The
6/12/24-month sweep is identical for the third time: every lot is under four months old, so
every window weighs every lot at 1. **Only the archive can answer the recency question**;
more live sweeping cannot, until a year has passed.

## Still to do

- Re-run after ticket 10 loads the archive; record the sweep, and whether a longer window lifts
  or drowns the rankable group.
- Record archive CPV coverage then: a low figure would exercise the text fallback here and decide
  whether the one-off AI tagging batch is worth its ~$17–33.
