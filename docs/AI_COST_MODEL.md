# AI cost model

What the AI layer costs, what is measured versus estimated, and the levers that change it.
Written so the numbers do not have to be rediscovered when the remaining AI features are built.

Nothing here is a decision about which model to use. That comparison is **parked** — see the
last section for the data already collected so it is not lost.

---

## The one number that drives everything

**Armenian costs 0.623 Claude tokens per character.** Measured, not estimated: 4,000 characters
of a real invitation body returned `input_tokens: 2492` from `claude-opus-5`.

English is roughly 0.25 tokens/char. So **the same document costs ~2.5× more in Armenian than
in English**, and no prompt change can recover it. Every figure below inherits this.

The corpus average invitation is **254,665 characters** (tid 47009, measured — the archive
parses to that after `hraver.docx` extraction).

## Measured: the bid checklist (`checklist.extract`)

The only AI feature whose cost has been measured end to end against a real document.

| | tokens | `claude-opus-5` |
|---|---|---|
| input — document | 158,700 | |
| input — system prompt + JSON schema | 1,431 (measured via `cache_creation_input_tokens`) | |
| **input total** | **160,129** | **$0.80** |
| output — 57 items with Armenian evidence spans, + thinking | ~11,400 (extrapolated) | **$0.29** |
| | | **≈ $1.09 per tender** |

Input is **74% of the cost and is fixed** — it is the document. Only the output half moves with
prompt or model changes.

Confidence: input is measured and solid. Output is extrapolated from a real 57-item response
plus an allowance for adaptive thinking, so the true total sits around **$1.00–$1.20**.
`npm run checklist:try` prints exact `usage` on every run — replace this estimate with a real
number at the first opportunity.

**Prompt caching barely helps here.** The cacheable prefix is ~1,431 tokens against a ~158,700
token document, so it saves ~1.4%. It is still correct to keep — it costs nothing and matters
for repeat runs of the same tender — but it is not a cost lever at this document size.

## Estimated: the rest of the AI surface

Seven features are planned. **Only two are document-scale.** Costs below are per invocation,
using Opus rates; treat everything except the checklist as an estimate.

| feature (spec name) | input scale | ≈ cost | state |
|---|---|---|---|
| **Պահանջների ցուցակ** — spec-to-checklist | whole invitation, ~160k tok | **$1.09** | **built** |
| **Հայտի փաստաթղթերի գեներատոր** — proposal/form drafting | checklist + vault + tender; output-heavy | **~$0.60** | not built |
| Մասնակցե՞լ / Չմասնակցե՞լ — go/no-go | evidence packet, ~2k tok | ~$0.03 | not built |
| «Պատվերով տենդերի» ազդանշան — wired-spec signal | statistics + narration | ~$0.02 | not built |
| **Գնի առաջարկ** — price recommendation | ~2k tok, Redis-cached on evidence hash | ~$0.02 | **built** |
| Համապատասխանության դասակարգում — classification/tagging | title + CPV vs profile | ~$0.0005 | not built |
| Առաջիկա տենդերների կանխատեսում — forecasting | — | **~$0** | not built — see below |

### Forecasting should not be an LLM

It is absent from the reference spec's AI inventory, correctly. "This buyer procures tyres every
March" is frequency analysis over `tenders` + `awards`, and 17,051 awards with dates already
exist. That is a SQL window function. An LLM would be slower, dearer, and *worse* — it would
guess where SQL counts.

Same split as the price recommendation: **numbers from SQL, narration from the model.**

### Classification is a volume risk, not a unit-cost risk

At ~$0.0005 per call it is negligible per tender, but it runs on every new tender against every
saved search. Two rules keep it that way:

- Run it only on tenders that **already passed the rule-based matcher** — it is a re-rank, not a
  replacement for `matcher.service.js`.
- Use the **Batches API (50% off)** for the historical corpus. Bulk classification of the
  archive is the textbook non-urgent batch job.

At ~2,600 new tenders a month this is roughly **$1.30/month across the entire user base**, not
per customer. It does not need a quota.

## Per-customer monthly model

A supplier pursuing 20 tenders and generating 10 document sets, on Opus throughout:

| | |
|---|---|
| checklist — 20 × $1.09 | $21.80 |
| document generator — 10 × $0.60 | $6.00 |
| go/no-go + price rec + wired signal — 40 calls | $1.40 |
| **total** | **≈ $29/month/customer** |
| against the seeded `pro` plan at $115 | **25% of revenue** |

Two features are **97% of per-customer spend**. Quota those; ignore the rest.

## Cost levers, strongest first

1. **Share the extraction across tenants.** `checklists` is keyed to `tracked_tender_id`, so it
   is per organisation — two suppliers pursuing the same tender pay for a byte-identical
   extraction twice. The extraction depends only on the invitation, which is **public
   procurement data, not tenant data**, so a shared tender-level result keyed on
   `checklists.document_hash` crosses no isolation boundary. The per-org checklist becomes a
   copy; `done` flags, manual items and review state stay private, which is the part that
   genuinely is tenant data. With customers clustering on the ~115 tenders open at any time,
   this is an order-of-magnitude lever and needs no model downgrade.
2. **Do not send the whole document.** ~99% of input is the invitation, much of it procurement-law
   boilerplate identical across tenders. Sending only tender-specific sections would cut input
   several-fold. Real work, and it risks dropping requirements — the same reason the current
   design refuses to truncate — but it is where the remaining money is.
3. **Model right-sizing.** Parked. See below.
4. **Batches API at 50%** for non-urgent bulk (classification of the archive).
5. **Prompt caching.** Already implemented; ~1.4% at this document size.

Already implemented and costing nothing — neither should ever count against a quota:

- `checklists.document_hash` — regenerating an unchanged document skips the model entirely.
- `priceRecommendation` — Redis-cached on a hash of its evidence, so repeat views are free and a
  new award invalidates it automatically.

## Quota design sketch

**Built** (subscriptions ticket 08, spec `.scratch/subscriptions/quota-spec.md`). Every accepted
`POST /tracked-tenders/:id/checklist/generate` spends one checklist generation, `force` included;
at the limit it is refused `429 QUOTA_EXCEEDED` with `{ used, limit, resetsAt }`. The limits are
`CHECKLIST_QUOTA` beside `PLAN_GATED` in `libs/permissions.js`, read from the subscription
covering now (never the token), given a supplier realistically pursues ~20 tenders a month:

| plan | price | checklist generations / month |
|---|---|---|
| free (no subscription) | $0 | 0 — feature gated entirely |
| trial (any plan) | $0 | 10 — enough to see it work, at most ~$11 per trial |
| starter | $40 | 5 |
| pro | $115 | 30 |
| business | $250 | 100 |
| enterprise | $600 | 300 (the sketch said metered; there is no metering without payments) |

**The window** is a calendar month in Asia/Yerevan, opened at the later of the 1st and the
current subscription's start, so a new subscription — a promo redeemed mid-trial — starts with
its full quota. Each accepted request is a `checklist_generations` row, written under the
organization row lock before the job is queued; deleting a pursuit refunds nothing. A tender
with no stored invitation is refused before the quota and costs nothing — the commonest case,
since most tenders have no archive. A job that then finds nothing to do (`unchanged`,
`no_text`) does not give the unit back.

Hard-stop at the limit rather than bill-through: simpler, and no surprise invoices while the
real numbers are still being learned. The document generator is expected to spend from the same
quota when it is built.

**Before setting any of these, persist actual usage.** The adapter already returns
`input_tokens` / `output_tokens`; `aiExtractor.js` logs them and throws them away. Storing them
per extraction is small work and is the difference between modelling the margin and knowing it.

## The risk feature is not the expensive one

**Հայտի փաստաթղթերի գեներատոր** drafts documents a supplier legally submits. CLAUDE.md's rule —
*AI output is advisory; nothing AI-produced is presented as legally authoritative* — strains
hardest here.

It needs the same containment discipline the checklist got, designed **before** it is built:
every generated clause traceable to a template or a vault document rather than free-composed,
and a mandatory human sign-off before submission. The checklist's equivalent is
`verifyEvidence`, and it exists because a prompt rule is guidance while a containment check is
an invariant.

## Parked: model selection

No decision. Data collected so far on tid 47009, same prompt, same document, all evidence spans
run through the production `verifyEvidence` gate:

| | items | evidence gate | flagged for review | confidence | `documentQuality` | ≈ cost |
|---|---|---|---|---|---|---|
| `claude-opus-5` | 57 | 50/50 pass | 9 | 0.50–0.93 | `partial` + correct diagnosis | $1.09 |
| `claude-sonnet-5` | 33 | 32/33 pass | 1 | 0.60–0.97 | `good` (missed the defect) | ~$0.44 |
| `qwen/qwen3.7-flash` | 22 | 22/22 pass | 0 | **1.00 on every item** | `good` (missed the defect) | $0.005 |

### The nine operationally decisive items

Pre-registered before the runs: the requirements that decide whether a bid is *possible*, not
merely complete.

| | Opus | Sonnet | qwen |
|---|---|---|---|
| PIN code gate (no price offer without it) | ✅ | ✅ 0.75 | ❌ |
| bid accepted only once price offer confirmed | ✅ | partial | ❌ |
| auction start date | ✅ | ✅ | ❌ |
| **auction step must cut ≥1%** | ✅ | ❌ | ❌ |
| securities within 5 working days | ✅ | ✅ | ❌ |
| **qualification security treasury account** | ✅ | ❌ | ❌ |
| **contract security treasury account** | ✅ | ❌ | ❌ |
| sign contract or lose the right | ✅ | ✅ | ❌ |
| **delivery: 30 days to Metsamor** | ✅ | ❌ | ❌ |
| **score** | **9/9** | **~5/9** | **0/9** |

### Sonnet found three things Opus did not

Recall is not a strict ordering. Sonnet surfaced, and Opus missed:

- the right to request clarification ≥5 calendar days before the deadline;
- the right to **anonymously challenge the technical specification** on competition and
  non-discrimination grounds — directly relevant to the wired-spec feature;
- the obligation to extend bid-security validity when the invitation is amended.

The union of the three runs is larger than any single run. On a 254,665-character legal document
**no model returned a complete checklist**, which argues that the `documentQuality` signal and
the human-review path matter more than model choice — and that this comparison rests on **one
document**, which is not a benchmark.

### Notes

- Sonnet's single drop was `Որակավորում ապահովում` where the document reads
  `Որակավորման ապահովում` — one missing suffix on a real requirement (the Fitch/Moody's/S&P
  exemption from the 15% qualification security). The gate worked exactly as designed.
- Sonnet's PIN item sits at **exactly 0.75**, and `flagForReview` is `confidence < threshold`,
  so a critical item passes unflagged by one hundredth. Worth remembering if the threshold is
  ever tuned.
- Only Opus flagged the document defect (Part I runs 6 → 8; tables arrive flattened). Both
  cheaper models reported `good`.

Neither model fabricated — both quote verbatim. The difference is **coverage**: 29 of the 50
Opus spans have no counterpart in qwen's output, including the PIN-code sequence (you cannot
submit a price offer without it), confirming the price offer (the bid is not accepted until you
do), the auction date and 1% step rule, the 5-working-day deadline for securities, and the
treasury account numbers.

Also unresolved: qwen returns `1.00` on everything, which makes `AI_CHECKLIST_MIN_CONFIDENCE`
inert and the human-review path dead. Opus's 9 flagged items were exactly the uncertain ones —
lot specs reconstructed from tables the parser flattens.

The reference spec's own default for this task is **`claude-sonnet-5`**, with Opus reserved for
hard documents. Sonnet has not been tested and sits at roughly half the cost of Opus. Run
`npm run checklist:try -- --tid 47009 --eval` to regenerate the comparison package when this is
picked up again.

## Open, unrelated to model choice

- **The parser may be dropping content.** Opus flagged Part I section 7 as missing; verified —
  the headings run 6 → 8. Tables also arrive flattened into single-column runs, which is why lot
  specifications scored 0.55 confidence. Likely candidate: `w:txbxContent` textboxes, which are
  not in the main paragraph flow.
- **`documentQuality` is stored and never used.** The service records `good` / `partial` /
  `unusable` and nothing acts on it. It is the natural trigger for escalating a hard document to
  a stronger model.
