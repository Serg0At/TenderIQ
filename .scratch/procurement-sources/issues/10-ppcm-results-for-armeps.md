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
- **Lots with bids and no winner are written** (bids only, tender stays `closed`). Every such lot
  seen was ≥ 1 month past opening with every bid flagged, i.e. a failed lot, and PPCM shows
  nothing at opening. Should a buyer ever file bids before choosing a winner, `bids.reconcile`
  would read `lost` there — the existing rule, unchanged as the ticket asks; worth watching.
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
- **A partly awarded tender stops being asked**: `awarded` is terminal, so lots PPCM reports later
  are not fetched. The same is true of e-auction today.
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
partly awarded tenders stop being asked, and reconcile across channels (tickets 11 and 32).
