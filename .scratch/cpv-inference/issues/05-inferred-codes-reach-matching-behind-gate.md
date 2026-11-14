# 05 — Inferred codes reach matching, filters and relevance, behind the gate

**What to build:** With the gate on, an inferred code works like a stated one everywhere
discovery asks for a code. A saved search on that code alerts, the CPV and field filters find
the tender, and relevance ranks it. Every alert, email and digest line that matched only through
an inferred code says "(inferred CPV)". Intelligence never sees inferred codes, and this ticket
proves it. With the gate off, nothing changes. See `.scratch/cpv-inference/spec.md`, *Readers
that use inferred codes* and *Alerts*, and ADR 0006.

**Blocked by:** 04 — Biddable lots get inferred codes at ingest.

**Status:** done

- [x] A config flag (one config file, off by default) decides whether readers use inferred codes.
- [x] `libs/cpv.js#tenderCodes` and its SQL twin `tender.repo.js#tenderCodesSql` include inferred
      lot codes when the flag is on, and change together.
- [x] When the job writes inferred codes, it re-runs the match for that tender (`TenderIngested`,
      as ticket 25 does after a document set). `notifications_dedupe_uq` keeps it to one alert
      per organization and event.
- [x] A match whose CPV reason comes only from an inferred code says so in its reasons; the
      Telegram, email and digest renderers show "(inferred CPV)". Old notifications still render.
- [x] No intelligence query is edited: a benchmark, a buyer or supplier profile and competitor
      prices computed with inferred-coded lots present equal the same computed without them
      (checked).
- [x] CLAUDE.md's *Current state* gains the inferred-CPV bullet (separate column, who reads it and
      who never does, classifier and refresh, the gate), and the ticket-17 bullet's "primary ∪
      `cpv_codes` ∪ lot codes" names inferred lot codes.
- [x] Verified by hand with the flag on: a saved search on a code inferred for a biddable paper
      lot raises exactly one alert, marked "(inferred CPV)"; the field filter finds the tender;
      with the flag off, neither happens.
- [x] End the report by telling the owner to restart the API and the worker.

## Done — 2026-11-14

Verified on the local `tendra` database, with the gate empty and with it holding a kind. Nothing
was fetched from a source.

- **The gate is a list, not a flag** (the owner's call when the ticket was handed over):
  `CPV_INFERENCE.READ_KINDS` (`CPV_INFERENCE_READ_KINDS=goods,works,services`, any subset).
  Read in `variables.config.js` only, by a new `oneOfList` that refuses to boot on an unknown
  kind. It is empty by default. A lot's inferred code counts only when its tender's kind is
  listed.
- **Paper has no purchase kind**, so a gate on `goods_works_services` alone could never pass a
  paper lot: all 371 paper tenders hold NULL there. Decided with the owner: the gate reads
  `libs/purchaseKinds.js#gateKindOf`, the source's label, else the procedure code's marker
  (`ԱՊՁԲ` goods, `ԱՇՁԲ` works, `ԾՁԲ` services). On ARMEPS and e-auction the marker agrees with
  the label on 1004 of 1013 tenders. It gives a kind to every paper tender that has a code (356
  of 371; the other 15 have no code and never pass). The SQL twin is `tender.repo.js#gateKindSql`,
  built from the same tables and pattern. Nothing is written to `goods_works_services`, and the
  purchase-kind filter still reads the label alone. **Follow-up for the owner:**
  `filter[purchaseKind]` therefore still never returns a paper tender. Writing the marker's
  kind into the column at paper normalize would fix that, and it is a separate change.
- **The twins.** `tenderCodes(tender, { inferredKinds })` and
  `tenderCodesSql(alias, { inferredKinds })` both take the gate as an argument, shut by default.
  `libs/cpv.js` stays pure, and no repository reads config. Each caller passes
  `config.CPV_INFERENCE.READ_KINDS`: the matcher worker, and `tender.service.js` (filters and
  relevance). With the gate empty the SQL is byte-identical to before. **Relevance scores per
  lot**, and its lot column (`lotsColumn`) read `l.cpv_code` directly, so the lot-level half of
  `tenderCodesSql` is now its own export, `lotCodeSql`, and `lotsColumn` reads it. That keeps a
  lot coded one way wherever it is read, with no third rule. A tracked tender's codes
  (`relevance.repo.js#pipelineFor`) go through `tenderCodesSql` and so pass the gate too. The
  org's bid ledger and the relevance backtest's `findBiddableAsOf` still read stated codes only
  (history: inferred codes exist only on tenders biddable at ingest).
- **Twins agree**: over all 3,646 tenders, under the gate `[]`, `[goods]` and all three, JS
  `tenderCodes` equals SQL `tenderCodesSql` on every tender, and `gateKindOf` equals
  `gateKindSql` on every tender.
- **Matcher.** Stated codes are matched first. Only when they miss are the gated inferred codes
  tried, so a stated hit, even a family one, is never reported as inferred. An inferred hit
  scores as a stated one (0.7 exact, 0.5 family), and its reason is
  `exact CPV match (inferred CPV)` (`libs/cpv.js#INFERRED_CPV_MARK`). Each match in
  `matchedSearches` carries `inferredCpv: true` only when true, so old payloads read the same.
  Instant alerts render the reason as before (Telegram, email). The digest, which shows no
  reasons, marks the search's name (`matchedSearchesLine(…, { markInferred: true })`).
- **Re-match.** `CpvCodingService.queueRematch`, called by the `cpv.infer` worker after a run,
  and after a last attempt that gave up (codes an earlier attempt wrote must still reach
  searches). It queues `match.tender` `TenderIngested` on ALERTS (job id
  `match-{tenderId}-cpv-{sha(inferJobId)}`, `names.js#inferredMatchJobId`) only when a lot holds
  an inferred code, the gate passes the tender's kind and the tender is open. With the gate
  empty, nothing is queued.
- **API reference** updated: filters, alerts and relevance read inferred codes behind the
  server's per-kind switch, and the marker is documented.

### By hand

Tender `x7gyfmd6…` (paper, `ՓՔԿ-ԳՀԱՊՁԲ-26/4`, goods by its marker, active, v2), lot 2
«Հելիում գազ» inferred `33141212`. A scratch saved search on `33141212` with no keyword
(org `bida9tbe…`), the `cpv.infer` handler run on the tender, and the queued match run by hand
(no worker running), twice:

| | gate `[]` | gate `[goods]` |
|---|---|---|
| re-match queued | no | yes (`TenderIngested`, v2) |
| match run 1 / run 2: notified | 0 / 0 | 1 / 0 (deduped) |
| notification reasons | — | `exact CPV match (inferred CPV)` |
| `filter[field]=medical` (paper) finds it | no | yes |
| `filter[cpv]=33141212` finds it | no | yes |
| relevance ranks it | no | yes (score 0.33) |
| `version` | 2 → 2 | 2 → 2 |

Rendered with the gate on: Telegram and email show `exact CPV match (inferred CPV)`, and both
digests show `Matched: … 33141212 (inferred CPV)`. Pure checks: an old payload (no flag, plain
reasons) and one older than `matchedSearches` render as before; a stated family hit beats an
inferred exact one, unmarked; a tender with no kind never passes; a gate naming another kind
does not pass. The scratch search and notifications were deleted afterwards, and no re-match job
was left in Redis.

### Intelligence is unchanged (checked)

Gate on all three kinds. 8 awarded lots with no stated code (on 7 tenders) were given the
inferred code `44621170`. With the lot already inferred on the awarded paper tender `cknp0…`,
that made 11 inferred-coded lots, 9 of them awarded. Then every inferred code in the database
was removed, and the figures were computed both ways: the benchmark (`compute`, every tier) for
`44621170`, the exact and group (`446`) stats, `categoriesWithAwards`, expected competition,
competitor prices and benchmark categories for each of the 8 tenders, and the profiles of their
6 buyers and 7 winning suppliers. **34 figures, 0 different.** The benchmark for `44621170` is
`insufficient_data`, sample size 0, with 9 awarded lots inferred to that code, so it never
counts them. Every touched lot was restored exactly (checked).

Restart the API and the worker: both read the gate and the new reader code.
