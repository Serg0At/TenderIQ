---
status: accepted
date: 2026-11-13
---

# Inferred CPV codes are chosen from the national classifier, kept apart from stated codes, and never enter intelligence

A lot whose source states no CPV code (in practice most paper lots) gets an **inferred CPV
code**. That code is **chosen, never written**: candidates come from lots Armenian buyers have
coded and from Armenia's official **CPV classifier** (the Ministry of Finance's «Գնումների
միասնական անվանացանկ», loaded into a table). A cheap model picks one candidate or `none`, and a
code outside the classifier is refused by a foreign key. The inferred code lives in **its own
column**, never in the stated-code columns. It feeds matching, the CPV and field filters and
relevance, and it is **never read by any intelligence figure** or by the amendment fingerprint.
Discovery is where a missed tender costs a customer, and a wrong extra match only costs a glance.
A benchmark computed over guessed comparables would break the rule that intelligence is never
fabricated, and nothing on the page would show it.

## Considered options

- **Let the model write an 8-digit code freely.** There is nothing to check a free answer
  against except the classifier, and below class level Armenia renumbered CPV, so a plausible
  EU code is often a different item here (03111200 is sugar beet in Armenia, peanuts in EU CPV).
  Choosing from candidates makes an invented code impossible rather than unlikely.
- **Write inferred codes into `cpv_code` / `cpv_codes` with a flag.** Every intelligence query
  would then need a filter, and the first one written without it would mix guesses into
  benchmarks while reading as correct. A separate column keeps intelligence clean by
  construction: no intelligence query is edited.
- **Take a competitor's classification (HayTender).** Their codes are their work, and possibly
  inferred too. The official classifier is public, complete (11,386 codes, 2026-11-11) and
  contains all but one of the stated codes Tendra holds.
- **No model: the nearest labelled lot's code.** Kept as the backtest baseline and as a fallback
  method. Which method switches alerts on is decided by the backtest, gated at ≥90% division
  agreement per purchase kind.

## Consequences

- `libs/cpv.js#tenderCodes` and `tender.repo.js#tenderCodesSql` read stated ∪ inferred, and they
  still move together. Anything new that measures prices or competition must read stated codes
  only.
- Codes are inferred only for tenders biddable when ingested, because a closed tender's inferred
  code feeds no alert and no figure. Closed e-auctions lacking codes are recovered by the
  document backfill, from the source.
