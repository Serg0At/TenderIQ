# 3. Relevance ranks on the CPV hierarchy, not AI

Date: 2026-10-17

## Status

Accepted

## Context

FR-DISC-4 asks for tenders ranked by relevance to an organization's profile and history. The
customer-facing feature list advertises it as "Relevance ranking 🤖", and the reference spec's
`ai/Embeddings.md` puts meaning-based matching in V2/V3. So the obvious reading is that ranking
is an AI feature.

Three things measured against the live corpus argue otherwise.

**CPV is not sparse where it matters.** `profile.repo.js` records that CPV "exists for roughly a
third of the corpus", which is true of the whole archive and false of the tenders this feature
orders. Of 148 biddable tenders, **147 carry a CPV code on at least one lot**, because the
invitation archive is fetched for current tenders. Subject similarity can therefore be decided by
the code the invitation already states — exact code, then 3-digit group, then 2-digit division.

**The text AI would read is mostly noise.** Lot names average ~3,000 characters per tender, and a
sampled read finds entries like `տես կից ֆայլը` ("see attached file") and whole specification
paragraphs. An embedding over that is not obviously better than the structured code sitting beside
it.

**Per-org model judgement does not survive its own arithmetic.** Scoring 148 biddable tenders per
organization costs about $0.50 per refresh on Haiku 4.5 and $2.50 on Opus 5 (Armenian runs 0.623
tokens/char; ~1,900 tokens of tender text per call). At 100 organizations refreshing daily that is
**$1,500–7,500/month**, against a $115 `pro` plan. Unlike the checklist, the result is per tenant,
so it cannot be shared the way `checklists.document_hash` shares an extraction.

## Decision

Relevance is scored by a deterministic function over the CPV hierarchy, the public bid ledger,
pursuit history, saved searches and the organization's field. No model call is on the path of a
relevance request.

Rarity-weighted word overlap is the fallback for the rare tender with no CPV, and lives in its own
module rather than inside the scorer.

AI keeps exactly one job in this feature, and it is not ranking: a **one-off batch assigning CPV
divisions to archive tenders that have none** (~29,000 titles, about $17–33 on Haiku with the
Batches API). It is only worth running if the backtest shows history is too thin without it.

## Consequences

- Every ranking can explain itself from stored facts — "exact CPV 33141110 on lot 7; you won 3 lots
  at this buyer" — which is what the honest-intelligence rule requires of anything the product
  asserts. A model's similarity judgement could not be evidenced this way.
- Ranking costs nothing per request and nothing per organization, so it needs no quota and no AI
  entitlement of its own.
- Relevance is only as good as the CPV codes. A source that stops publishing invitation archives
  degrades ranking to text fallback, and the 147/148 figure must be re-measured, not assumed.
- Semantic similarity (a supplier whose line of business crosses CPV divisions) is not captured.
  Embeddings remain the V2/V3 answer; this decision defers them, it does not refuse them.
- The marketing claim "Relevance ranking 🤖" is not met by v1. Either the copy changes, or the
  archive-tagging batch above becomes the AI the claim refers to.
