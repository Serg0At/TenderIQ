# 10 — PPCM results for ARMEPS tenders

**What to build:** A supplier sees every bidder's price on a finished ARMEPS tender, and a bid they
submitted on one is reconciled into won, lost or not_found. A tender PPCM has not reported yet
stays unresolved, never lost. Spec: *Sources and parsers → PPCM*. Research: *Verification against
our e-auction ledger*.

**Blocked by:** 05

**Status:** done

- [x] A `ppcm` adapter: the client loads the reports page for a session cookie, then `POST`s
      report requests. `values` is a list of `{paramId, value}` with a **plain string** value,
      and `page` is `{index, size}`. Report and parameter ids live in the sources config.
- [x] A per-tender results refresh, scheduled like `tender.refresh`, queries the organized
      procedures report by procedure code for ARMEPS tenders past deadline and unresolved, within
      a refresh window.
- [x] Each returned row resolves through the resolution module: our code, the `armeps` channel,
      and announcement and opening dates. A mismatch or ambiguity is an unmatched result.
- [x] Rows write `public_tender_bids` and `awards` with `source = 'ppcm'`.
      `participant_total_price` is **net**, and `contract_price` is the **gross** award.
      Bidder ՀՎՀՀ lands on the party.
- [x] The tender becomes `awarded` through *derive status*, with PPCM as the owning source for
      ARMEPS.
- [x] `bids.reconcile` resolves ARMEPS bids from these rows with no change to its rules.
      `not_found` stays retryable.
- [x] Raw JSON responses are stored. Politeness is no looser than eauction's, and a session
      expiry is renewed, not retried blindly.
- [x] Verified by hand on three ARMEPS tenders (including an open tender): the stored rows equal
      PPCM's report rows. Record them here. *(26/30 is a real armeps.am-created tender; the open
      and the failed-lot tenders are throwaway stand-ins carrying real procedures — see below.
      The first open ARMEPS tender PPCM reports is a live check.)*

## Verification (2026-10-23/27, local Postgres `tendra`, MinIO, Redis `localhost:6379`, live PPCM)

No worker was running. The production refresh (`ppcmRefresher.find`) and handler
(`handlePpcmResults`) were driven in-process; downstream match and benchmark jobs were run
through their production handlers (`processMatch`, `handleRecomputeBenchmarks`) and removed.
Every PPCM request went through armeps.am's rate limiter, scripted asks ≥ 3 s apart — about
40 requests to armeps.am over the whole ticket, research probes included. No test runner: the
pure rules are 50 assertions in a scratch script, over real PPCM answers, and 20 rebuilt after
the review's fixes (the machine restarted on 10-27 and took the scratch fixtures with it).

**Pure rules (50 assertions).** The 26/30 answer as received → one procedure, `armeps`,
`quotation`, announced 2026-07-21T08:46:41Z, opened 07-28T11:00Z, two bids at their net
offers with no gross and no rejection read, award 08422716 at 12 369 600 gross / 10 308 000
net, budget 0 → null. Resolution: looked up in the ARMEPS channel; one fitting tender →
`link` rule `code`; linked → rule `link`; two same-day runs → `ambiguous`; another
announcement day, another opening day, a lot the tender lacks, a paper tender of the code,
nothing held → `no_candidate`, `wasPublic` null, never `create`. Status: PPCM's `awarded`
awards ARMEPS and nothing else (not paper, not e-auction), bids without a winner leave
`closed`, a terminal status stays. The multi-lot open sample (lots 15/16/33/34, contract price
per lot), failed lots (bids, no award, no status), fractional nets, two announcements → two
procedures, a bidder listed twice, a row of another code and a row of another width → throw,
an unserved page → throw, an empty answer → nothing, pages concatenate, an auction form →
`eauction`. A lot joined to two contracts → the one priced at its winner's offer; to two
priced at neither → the lot is not read, the other lots stand; one contract → its price,
framework or not; a code with a trailing space is the same code, another code throws. PPCM's 15 forms
(`get-form-list`) map as listed in `observation.js#FORMS`. Single source never crosses:
single-source result on a competitive tender and the reverse → `no_candidate`; on a
single-source tender → `link`; no stated type → no opinion; the type picks between two
same-day runs.

### By hand: the stored rows against PPCM's rows

Compared by a script that reads PPCM's rows straight out of the stored answer (not through
the observation module) against `public_tender_bids` and `awards` joined to their parties:

| tender | PPCM rows | bids PPCM / stored | lots | awards expected / stored | mismatches |
|---|---|---|---|---|---|
| ԱՄՄՀ-ԳՀԱՇՁԲ-26/30 (quotation, real, `armeps:12315509`) | 2 | 2 / 2 | 1 | 1 / 1 | 0 |
| ԱՄԱՀ-ԲՄԽԾՁԲ-26/09 (**open**, 38 lots, stand-in) | 140 (2 pages) | 133 / 133 | 38 | 36 / 36 | 0 |
| ԱԲՀ-ԲՄԽԱՇՁԲ-25/137 (open, every lot failed, stand-in) | 70 | 70 / 70 | 11 | 0 / 0 | 0 |

26/30 in full (equal to research.md's reading of the same report):

| lot | bidder | ՀՎՀՀ | net (`participant_total_price`) | award gross (`contract_price`) | signed |
|---|---|---|---|---|---|
| 1 | Էռվիէռ Քոմֆորտ ՍՊԸ | 08422716 | 10 308 000 | 12 369 600 | 2026-08-27 (Yerevan) |
| 1 | ԱՐՍՏՈՆ ՍՊԸ | 08425842 | 11 550 000 | | |

Both parties are `ppcm:bo:{ՀՎՀՀ}` with `tax_id` set; `source = 'ppcm'` on every row,
`final_offer_price`, `vat_pct`, `rank` and `budget_price` null, `status` `accepted`.

**The open tender is a stand-in, and the box stays half-open for that.** Tendra holds one ARMEPS
tender past its deadline (26/30): gnumner only links armeps.am pages from ~2026-10-12 on (its
older listing and amendment pages are uploads only), PPCM's `bid-report`, `contracts/list` and
`list-tender` answer `{"status":500}`, and e-PPS's advanced search covers organisations only — so
no `resourceId` of a finished open tender could be found. The stand-ins were throwaway
`tenders` rows (`standin:ticket10:*`, buyer included) carrying the real procedures' code,
channel, type and dates; the asks against them were real PPCM requests through the production
handler. Every trace — tenders, links, bids, awards, the 12 parties, payload rows and stored
objects, queued jobs, throwaway organizations — was removed, and every domain checksum went
back to its value after the 26/30 ask. The real check on an armeps.am-created open tender is
in *Live checks pending*: the first open ARMEPS tender in `tendra` that PPCM reports.

### The rest of the box list

- **Refresh:** `find` picked 26/30 (deadline 07-28, inside the 90-day window) — the only
  ARMEPS tender past its deadline; a second run within 24 h picked nothing (`ppcm:asked:{code}`).
- **Status:** 26/30 `closed` → `awarded`, version 2, one `TenderAmended ['status']` match job →
  `skipped: status_awarded`; the benchmark recompute ran over 1 category and the benchmark says
  `insufficient_data` (sample 1 of 5). `competitor-prices`: both bidders, the loser 12% above
  the winner on net, winner price 12 369 600 / net 10 308 000.
- **Idempotent:** a repeat ask → `unchanged`, 0 writes; a `replay` from storage → the same
  decision, no version, every checksum identical. The first ask wrote exactly: 1 tender moved,
  1 link, 2 bids, 1 award, 2 parties, 1 payload.
- **Not reported yet:** a code PPCM does not have → the empty answer is stored, nothing else.
  PPCM had no rows either for three tenders that opened the day before (ԵՔ-ԳՀԱՇՁԲ-26/232,
  -26/233, ԵՔ-ԳՀԽԱՇՁԲ-26/84): it lists a procedure once results are filed, not at opening.
- **`bids.reconcile`, rules unchanged** (throwaway organizations claiming PPCM parties, one
  submitted bid each): 26/30 → `won` 10 308 000 and `lost` (winning 10 308 000); the open
  stand-in → `won` on lot 3 (the contract the price rule kept) and `lost` on lot 1 at 541 000;
  the unreported tender → left unresolved (`not_found`, retried next sweep); a failed lot →
  `lost`, no winning price — the existing rule for a lot with no award. Reconcile finds a bid only
  through the organization's claimed party, and a PPCM bidder is a new `ppcm:bo:{ՀՎՀՀ}` party:
  an organization that claimed its e-auction party stays `not_found` on ARMEPS bids until ticket
  11 matches parties by ՀՎՀՀ or ticket 32 lets it claim both — the rules are unchanged here.
- **Politeness:** PPCM spends armeps.am's own budget (`rateLimitSource: 'armeps'`, one host),
  rate limit before HTTP, throttle → `moveToDelayed`; polls ride `PRIORITY.RESULTS`, behind live
  discovery; ≤ 60 codes every 2 h, each at most once a day.
- **Session:** loaded once per process from the reports page. On 2026-10-23 `get-report`
  answered without a session and with a bogus cookie too (research saw `{"status":500}` without
  one on 10-17), so expiry cannot be provoked live. Against a local fake PPCM: a reused session
  answered HTTP 500, or `{"status":500}`, → one page load, asked once more, served; a fresh
  session refused again → thrown, and the next ask opened a new session rather than reuse the
  refused cookie. Never a second renewal in one ask.
- **Throttled:** an ask over armeps.am's budget (the fake-PPCM test had spent it) →
  `moveToDelayed`, no attempt spent.
- **An unchanged answer is resolved again while its tender holds no PPCM link** (the review's
  finding): a stand-in for ԱԲՀ-ԲՄԽԱՇՁԲ-25/137 with its deadline one day off → `no_candidate`;
  deadline corrected, the same answer → `resolvedAgain`, linked, 70 bids, the unmatched row
  resolved to the tender; asked again → `unchanged`, nothing written. Removed afterwards,
  checksums back to the state before it.
- **Nothing else moved:** all 31 stored gnumner contract notices re-read through the
  `ResultsService` refactor and the rule-3 change (twice: before and after the review's fixes) → 10 `no_candidate`, 18 `unsupported_format`,
  1 `no_code`, 2 linked, no job queued, every checksum identical. `normalize:replay` over 1 234
  stored payloads → only `tenders` moved: 39 tenders (26 ARMEPS, 13 paper) whose deadline
  passed on 10-26/27 between the baseline and the replay turned `closed` — the clock, as the
  hourly refresh would. Their match and document jobs were left queued.

## Decided while building

- **`bid_rejected` is not read**, for ARMEPS either: it is `true` on winning rows
  (ԱՄԱՀ-ԲՄԽԾՁԲ-26/09: all 15 rows of four lots, both winners included). Read as a rejection it
  would drop winners from every price range. Every PPCM bid is `accepted`; the award is named
  explicitly, so a win never rests on it.
- **No gross is invented for a bid.** PPCM states a net offer only; `final_offer_price` and
  `vat_pct` stay null. The award's gross is `contract_price`.
- **`contract_price` is what the buyer pays, not always the offer + VAT.** Of lots naming one
  contract, 49 of 59 in a 200-row sample of 2026 open tenders, 32 of 34 on 26/09 and 1 of 1 on
  26/30 are priced at the winner's offer, net or + 20%; the rest are framework or partial-funds contracts well below it (74 997 767 against an
  offer of 393 269 180). The award keeps the contract price as gross and the offer as net.
- **The report joins every contract of a procedure to each lot its winner bid on.** On 26/09, lot
  1 lists each bidder twice — against contract /1 at 649 200 (00813453's own 541 000 × 1.2) and
  /3 at 2 040 000 (04225682's 1 700 000 on lots 15–16). A lot naming several contracts keeps the
  one priced at its winner's own offer (± 2 AMD) — 2 of 2 such lots resolved on 26/09 — and with
  none is not read at all: its bids without an award would reconcile as every bidder's defeat,
  the real winner's included, while unread they stay `not_found`.
- **A procedure is its code and its announcement** (`{code}@{announced}`): a code is
  re-announced (ԵՔ-ԲՄԽԾՁԲ-26/3 has 11 rows across runs), and the report has no id of its own.
- **The filter is exact and case-sensitive**, so a row of another code means it stopped applying
  and the job fails rather than writing someone else's rows.
- **Lots with bids and no winner are written** (bids only, tender stays `closed`), as soon as
  PPCM publishes them. `bids.reconcile` leaves a bid on such a lot undecided until it has an
  award or a recorded failure (decided 2026-10-27, below).
- **Rule 3 refuses a single-source disagreement** (CLAUDE.md *Single source*): a result and a
  tender that both state a type and disagree on single source are not one procedure. PPCM's
  single-source forms are «Մեկ անձ» and «Հրատապ մեկ անձ»; its negotiated forms map to
  `single_source` as armeps.am's do. Everything PPCM writes is governed by the tender's
  `procedure_type`, so `competitiveOnlySql` keeps a single-source ARMEPS tender's prices out of
  competition figures and in totals with the split; unmatched PPCM rows keep PPCM's own form.
- **One answer per code, the code exactly as spelled** (`results:{code}`): the filter is exact and
  case-sensitive, so another spelling is another question. Two tenders Tendra holds under one
  code are asked about once, and each procedure in the answer resolves to its own.
- **A failed ask waits out its claim** (24 h): the claim is taken when the batch is picked.
  Results are not time-critical, and releasing it on failure would re-ask a broken code every run.
- ~~**A partly awarded tender stops being asked**~~ — reversed 2026-10-27, see *Follow-up*.
- **Paper's `recordContract` and PPCM share `ResultsService.record`**: status through the owners
  table, `recordResults`, the unmatched row resolved, the match job, the benchmark job.
- **No migration.** `refresh-ppcm` needs `npm run scheduler` after the deploy (added to ticket 30).

## Review (2026-10-27, `/code-review`, standards and spec axes)

Fixed: a lot whose winner cannot be placed wrote bids without an award (a possible fabricated
`lost`) — now not read; a session refused with an HTTP error status was retried with the same
cookie — now renewed once, and dropped when refused again; an unchanged answer was never
resolved again — now it is while the tender holds no PPCM link; the refresh deduped on the
normalized code but asked one spelling — now everything keys on the exact code, which also
removed the adapter's import of `resolution.service.js`; `ResultsService.record` decides the
benchmark gate from `decision.tender.resultOnly` itself rather than taking a flag.

Left, on purpose: the throttle `catch` repeats the six existing copies (extracting it touches
workers outside this ticket); the module-level session (one page load per process, documented
in the client); the poll claim not released on failure (above); `singleSourceDisagrees` also
governs gnumner contract notices — asked for, and the 31 stored notices decide as before;
reconcile across channels (tickets 11 and 32). (Partly awarded tenders stopping being asked was
left here too, and reversed by the follow-up.)

## Follow-up (2026-10-27, by decision)

1. **An ARMEPS tender is asked about while any lot is unsettled.** `findAwaitingResults` keeps a
   tender on the PPCM worklist — same 90-day window, same once-a-day claim — while any of its
   lots (`tender_lots` ∪ the ledger's) has neither an award nor a failure a notice recorded
   (`tender_sources.failed_lots`); only `cancelled` settles it outright. `awarded` comes with the
   first lot's contract and no longer stops the later ones arriving.
2. **A discount compares the winner's offer, never the contract.** `awards.amount` stays the
   contract for spend. `tender.repo.js#awardOfferSql` is the winning offer with VAT: `amount`,
   except on a PPCM award whose contract is not the winning net or net + 20% (± 2 AMD), where it
   is NULL. Every award-based discount — benchmark, buyer profile, supplier winning discount,
   competitor prices (per lot and the tender summary) — reads it, leaves the NULL lots out and
   counts them (`discountExcludedLots`; `winningDiscountExcludedLots` on a supplier), counting
   only lots that have a budget. Competitor prices' winner carries `offerPrice`. The stored
   benchmark keeps the count in `price_benchmarks.discount_excluded` —
   `migrations/add_benchmark_discount_excluded.js`, **ticket 30 step 12**, run on local
   `tendra` (twice; the second a no-op) and mirrored in `create_table.js`.

### Verification (local `tendra`, live PPCM, stand-ins removed afterwards)

Two throwaway stand-ins as before (`standin10open`, `standin10frame`, buyer included), real
PPCM procedures, every trace removed after — domain checksums back to their values before, the
stand-in buyer's benchmark row deleted before its party (its `SET NULL` would have left a global
row), claims and queued jobs cleared. Their deadlines are outside 90 days, so the worklist was
read with a wider window; the window itself is unchanged.

**(1) The 38-lot pattern (ԱՄԱՀ-ԲՄԽԾՁԲ-26/09), in two stages:**

| step | tender | lots with an award | on the worklist |
|---|---|---|---|
| created, nothing asked | `closed` v1 | 0 / — | yes |
| stage 1: PPCM's real answer with lots > 20 stripped of winner and contract (bids filed, contracts not yet), replayed | `awarded` v2 | 18 / 38 | **yes** (the old rule dropped it here) |
| stage 2: the real ask | `awarded` v2, no new version | 36 / 38 (18 above lot 20 arrived) | yes — lots 4 and 18 have bids and no winner |
| a failure notice recorded for lots 4 and 18 | `awarded` | 36 / 38 | no |

The real ARMEPS worklist (90 days) held 26 tenders throughout — the ones that closed on 10-26/27;
26/30, whose one lot is awarded, is not on it.

**(2) Discount from budget.** PPCM states no budget on 26/09 (0 on every row), so its 36 awards
got synthetic budgets of 110% of their contract. ՀՀԿԳՄՍՆԲՄԱՇՁԲ-24/10-1-Հ6 is a real framework
contract with a real budget: offer 393 269 180 net, contract and budget both 74 997 767.

| lot | budget | contract (`price`) | winning net | old discount | new |
|---|---|---|---|---|---|
| 24/10-1-Հ6 lot 1 | 74 997 767 | 74 997 767 | 393 269 180 | **0.0%** | `null`, counted |
| 26/09 lot 28 | 3 298 460 | 2 998 600 | 2 500 000 | 9.1% | `null`, counted |
| 26/09 lot 31 | 1 978 020 | 1 798 200 | 1 500 000 | 9.1% | `null`, counted |
| 26/09 lot 15 (priced as offer) | 2 244 000 | 2 040 000 | 1 700 000 | 9.1% | 9.1% |

- Competitor prices, 26/09: `totalAwarded` 47 438 800 (all 36 contracts), `totalDiscountPct`
  9.1 over the 34 comparable lots, `discountExcludedLots` 2; the framework tender:
  `totalDiscountPct` null, `discountExcludedLots` 1, `totalAwarded` 74 997 767.
- Buyer profile (the stand-in buyer): `totalSpend` 122 436 567 — all 37 contracts —
  `avgDiscountPct` 9.09 over 34 lots, `discountExcludedLots` 3.
- Supplier 06001677 (the framework's winner): `avgWinningDiscountPct` null,
  `winningDiscountExcludedLots` 1.
- Benchmark (CPV 71241200, the stand-in buyer's tier): sample 37, prices unchanged by the rule,
  `avgDiscountPct` 9.09, `discountExcludedLots` 3 — computed, stored by `recompute`, and read
  back from `price_benchmarks` by `forCategory`.

**Found on the way, fixed:** `competitorPrice.service.js#discountPct` read a missing price as a
**100% discount** (`Number(null)` is 0) — so did `gapPct` read it as −100%. It showed on the
excluded lots first; it would also have hit every PPCM bid (no gross) under a budget.

**Nothing else moved:** `awardOfferSql` equals `amount` on all 5 580 e-auction and 3 gnumner
awards, so every benchmark and profile discount outside PPCM is unchanged by construction. The
competitor-price **summary** did change on 3 e-auction tenders, deliberately: it divided every
awarded lot's total by only the budgeted lots' budgets, and now pairs each budget with its own
lot's offer — `y7ux3z8h6tcls4wugg1ry8vm` −790.5% → 24.0% (16 lots awarded, 2 budgeted),
`iy8rcymk2j1fh8gmvf2r7vyn` 7.4% → 39.1% (26, 18), `fy4qtkmm2b83pr65vsxb07i7` 5.5% → 5.9% (40, 39).
The pure observation checks (20) pass unchanged.

### ~~Open~~ — decided 2026-10-27: `bids.reconcile` decides per lot

The open question — a bid on a lot whose PPCM bids are published before its contract reconciled
as `lost`, final, even for whoever later won the lot — was decided as a fix to reconcile itself — "no change to its rules" meant
not changing it in passing, not keeping a wrong rule — for every source, e-auction included.
PPCM bids are still stored as soon as PPCM publishes them.

- **Per lot:** `won` only if the organization's party holds the lot's award; `lost` only if
  another party does. A lot with neither an award nor a recorded failure is undecided:
  `decide` returns no outcome, the sweep counts it `undecided` and retries, like `not_found`.
  `resolveOne` (run on submit) writes nothing then — nor for `not_found`, which it used to
  record permanently on a tender still to settle.
- **A failed lot keeps today's handling** (`lost`, no winning price). Recorded failure
  (`supplierEntriesForTender#lot_failed`): the tender `cancelled`; a failure notice naming the lot
  (`tender_sources.failed_lots`); or the source rejecting every bid on the lot. **The third is my
  reading of "recorded failure"** and the one to check: e-auction's accept/reject column is its
  own authority, and all 751 e-auction lots without an award on a tender that is not cancelled
  (302 awarded, 449 closed) are exactly that — read strictly, every one would stay unresolved
  forever. PPCM's bids are never stored `rejected`, so it cannot fire on an ARMEPS lot.
- **No lot named:** `won` if any lot is won; otherwise undecided while any lot is open, `lost` once
  every one went to another party or failed.

**Checked** (the 26/09 stand-in in two stages, as in *Follow-up*; throwaway organizations, each
claiming one bidder and holding one submitted bid; then everything removed — domain checksums
back to their values before):

| pursuit | stage 1: lot 21 has PPCM bids, no contract | stage 2: contracts in | failure for lots 4, 18 | old rule at stage 1 |
|---|---|---|---|---|
| A — 00813453, lot 21 | undecided | **won**, 583 000 | | `lost` |
| B — 04225682, lot 21 | undecided | **lost**, 583 000 | | `lost` |
| C — 57348351, no lot (bid lots 1, 4, 18, …) | undecided | undecided (lots 4, 18 open) | **lost**, 541 000 | `lost` |
| EW — e-auction lot winner (real tender) | won | | | won |
| EL — e-auction loser, same lot | lost, 6 400 000 | | | lost |
| ER — e-auction lot, every bid rejected | lost, no price | | | lost |

A is the case the old rule got wrong: `lost`, final, on the lot it then won.
