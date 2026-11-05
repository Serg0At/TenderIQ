# 05 — The relevant list, end to end

**What to build:** The feature, working — with the two weakest signals.

A supplier opens a second list beside Discovery and sees the tenders they could still bid on,
ordered by how well each fits their organization. Each row says strong, moderate or weak fit, and
carries the reasons behind that judgement. The plain Discovery list is untouched and still newest
first.

This slice cuts the whole path: the endpoint, the four gates, the candidate query, the pure
ranking function, bands, reasons, cursor paging, and the honest answer when there is nothing to
rank on. It deliberately scores on **saved searches and field only** — the two signals that need
no ledger work — so the plumbing lands in one piece. Tickets 06 and 08 deepen the scoring behind
the same contract.

The ranking rule is a **pure function**: candidate tenders, the organization's signal bundle, and
the current time in; an ordered list out. No Knex import, no queue, no clock of its own — the
shape `matcher.service.js` already establishes. That is what makes ticket 10's backtest possible
at all, and it is the seam a test suite would attach to if one is ever added.

Two things this must not do. It must not change which alerts fire: relevance and the alert match
are separate concepts that share code, and tuning one may never move the other. And it must not
invent an order — an organization with no saved search, no field, no pursuit history and no
supplier identity is told so, in the shape `/tracked-tenders/performance` already uses for
`insufficient_data`.

**Blocked by:** 02 (field list), 04 (shared CPV matching).

**Status:** done

- [x] A supplier can read a list of biddable tenders ordered by fit: best first, weakest last,
      nothing excluded for scoring low.
- [x] Biddable means current and still open — a tender with no deadline is included, and an
      explicit status filter from the caller wins over the default.
- [x] Equally-ranked tenders are ordered by which closes soonest, with no-deadline last, and then
      by identifier so the order is stable.
- [x] Cursor paging works across the full ordering, with the existing page-size default and cap;
      no tender is repeated or skipped between pages.
- [x] Every Discovery filter composes with the ranking, including the two from tickets 01 and 03.
- [x] Each row carries a band — strong, moderate or weak — and the numeric score; no screen is
      expected to show the number.
- [x] Each row carries reasons as stable codes plus values, never English prose, and a reason that
      matched on a lot names that lot.
- [x] A tender is scored on its best-matching lot, not an average across lots.
- [x] An organization with no basis to rank on receives a successful, empty response naming the
      basis as insufficient and listing what is missing, so the client can offer the right buttons.
- [x] The list is scoped to the caller's organization, gated on tender reading, and plan-gated on a
      new relevance entitlement from `pro` upward. Until a subscription writer exists every
      organization reads `free`, so this answers "upgrade required" for everyone — knowingly, as
      with invitations.
- [x] The scoring rule is a pure function with no database, queue or clock of its own, and scores
      are computed per request with nothing stored.
- [x] Alerts are provably unaffected: the matcher's threshold, weights and output are untouched.
- [x] Measured against the live database: the candidate set matches the biddable tenders actually
      present, and the response is inside the 1.5s P95 budget without a cache.
- [x] `docs/API_REFERENCE.md` documents the endpoint, the response shape and the insufficient-basis
      answer.

> P95 not yet measured where it counts: ~20 ms server-side execution and ~2 ms ranking, but
> wall-clock from a development machine to Neon us-east-2 was 3–9 s, all network. Measure from
> the deployed API before ticking.

> 2026-10-31, measured through the full HTTP API against the local Postgres, with no network
> between them. A throwaway org with three fields, a saved search with keywords and the three
> heaviest ledger suppliers as its identity (3,305 ledger lots, the worst case in the corpus):
> the walk returned all 294 biddable tenders over 6 pages, 0 repeats, 0 missing, 0 extra.
> `page[size]=50`, 40 requests each: page 1 p50 804 / **p95 884 ms**; page 4 p50 785 / p95
> 838 ms. Inside 1.5 s, but ~700 ms of that is `rankTenders` itself (DB: `signalsFor` ~30 ms,
> `findRankable` ~45 ms), and it grows with ledger size: 141 ms at 300 ledger lots, 595 ms at
> 3,305. `categorySignal` compares every unit code with every ledger lot of its division, per
> candidate. **The archive will multiply the ledger and break this budget**: fix that before
> ticket 10 lands, or re-measure straight after it.

> 2026-11-05, fixed and ticked. The ledger is now totalled per distinct CPV code
> (`relevance.service.js#indexLedger` / `ledgerNear`), each code's totals computed once per
> ranking per buyer, and a candidate's own lots subtracted rather than skipped; the known-buyer
> signal reads the same per-code totals. Output is byte-identical to the per-lot version: 600
> rankings (150 heaviest suppliers × today's and a past candidate set × two windows, 107 with
> the candidates' own lots in the ledger) and the 3-supplier fixture at 1, 3 and 24 months on
> a 15× ledger, where ½ and ¼ weights occur. `rankTenders` on the 3,305-lot fixture: 256 →
> 45 ms; on a synthetic 49,575-lot ledger (the fixture ×15, new tenders and buyers, aged back
> 15 months): **3,691 → 69 ms**, so the archive no longer moves it. Through the full API on
> the local Postgres, same fixture, 40 requests per page: 153 biddable tenders walked over 4
> pages with 0 repeats, missing or extra; page 1 p50 166 / **p95 174 ms**, last page p95 181
> ms. Measured on the local API and database rather than a deployed one: the remaining cost
> is ~75 ms of queries and ~45 ms of scoring, neither of which a deployment adds to.
