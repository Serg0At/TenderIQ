# 12 — Find tenders Tendra missed, through PPCM

**What to build:** Tendra notices when it missed a tender: PPCM reports a result that Tendra has no
tender for. Where it can, Tendra repairs the gap itself by fetching the armeps.am page. Everything
else is a counted `no_candidate` unmatched result, stored in the shape a future production operator
alert will read. ADR 0004: *a `no_candidate` result means Tendra missed a tender*.

**Blocked by:** 10

**Status:** done

- [x] A periodic sweep reads the organized procedures report by a recent date window, per
      procedure form, and resolves every row.
- [x] A row with no candidate is recorded as `no_candidate`. A re-seen row updates `last_seen`
      rather than duplicating.
- [x] If PPCM's bid-report supplies the `resourceId`, the armeps.am detail is enqueued (ticket 05's
      job), and once the tender exists the result re-resolves and attaches.
- [x] When bid-report is unavailable (it answered `status 500` to everything on 2026-10-18), the
      row stays `no_candidate` and counted. The sweep does not fail.
- [x] Whenever a tender is created or linked, unresolved unmatched results whose code matches are
      re-resolved, and attach when exactly one candidate fits. `resolved_tender_id` and
      `resolved_at` are set.
- [x] e-auction rows with no candidate are recorded, with no self-repair (no code → tid mapping).
- [x] No operator alert is sent. That is a later, production-only feature (spec *Out of Scope*).
- [x] Verified on the local DB: the sweep's `no_candidate` count, and at least one self-repaired
      ARMEPS tender if bid-report is up. Record both.

## Verification (2026-10-27/28, local Postgres `tendra`, MinIO, Redis `localhost:6379`)

No worker was running. The jobs ran in process with the production handlers, on real PPCM and
armeps.am requests, at armeps.am's configured budget. There is no test runner, so the pure
rules are 38 `node:assert` assertions in a scratch script: grouping a day by code, a day reading
a procedure exactly as its code does, the channel lookups, `other_channel`, `wasPublic` with
`armepsPage`, every `cftOf` outcome, and the stored bid-report round trip.

**The sweep's `no_candidate` count.** Over 5 forms × 91 days (455 day queries, about 21 minutes
at the budget), 906 procedures:

| form | rows | procedures | linked | `no_candidate` |
|---|---|---|---|---|
| Գնանշման հարցում (quotation) | 2,243 | 496 | 0 | 496 |
| Հրատապ բաց մրցույթ (urgent open) | 165 | 52 | 0 | 52 |
| Բաց մրցույթ (open) | 65 | 34 | 0 | 34 |
| Երկփուլ մրցույթ (two-stage) | 1 | 1 | 0 | 1 |
| Էլեկտրոնային աճուրդ (e-auction) | 5,577 | 323 | 217 | 106 |
| **total** | 8,051 | 906 | 217 | **689** |

No ARMEPS-form procedure linked. Tendra holds 54 ARMEPS tenders, discovered since about 10-12,
and PPCM lists a procedure only once results are filed, weeks later. That is a discovery gap by
date, not a bug.

`was_public` on the 689, after the repairs:

| `was_public` | n | what |
|---|---|---|
| `true` (**the misses**) | 563 + 1 resolved | bid-report names their armeps.am page: open 76, quotation 487 |
| `null` | 125 | e-auction 106 (gnumner never listed them); ARMEPS forms 19 |
| `false` | 0 | gnumner's covered window here is under a day, so nothing is provably never public |

The 19 ARMEPS-form `null`s: 17 have no bid-report entry for their run (mostly rows PPCM
announces at a bare 00:00Z date with an empty bid-report answer, likely paper procedures entered
into PPCM; a few are an older run of the code, opened in 2025; one opens a day apart on the two
sides). 1 is two bid-report entries of one code opening the same day (`ambiguous`, as rule 3
would say). 1 is the code whose bid-report ask timed out (30 s), which a job retry would ask
again.

**The self-repaired ARMEPS tender.** ԱՔ-ԳՀԱՇՁԲ-26/49 (quotation, announced 2026-07-29), whose
unmatched row read `no_candidate`, `was_public` true:

1. `armeps.detail` 12336848 (the `armepsId` bid-report gave): the CfT page was stored and
   normalized. The tender was created `closed`, quotation, published 07-29 05:59Z, deadline
   08-05 11:00Z, with a `detail` link.
2. The create queued one `ppcm.results` retry (`queuePpcmRetries`, `ppcm-retry-…-v1`). It linked
   the procedure by rule 3, wrote 3 bids and 1 award (`source = 'ppcm'`), and moved the tender
   to `awarded` v2:

   | lot | bidder | ՀՎՀՀ | net | award gross / net |
   |---|---|---|---|---|
   | 1 | Կանալ Քլինինգ Սերվիս ՍՊԸ | 01320739 | 4 155 000 | 4 986 000 / 4 155 000 |
   | 1 | 911 ԿՈՄՈՒՆԱԼ ՍԵՐՎԻՍ ՍՊԸ | 00534346 | 5 758 330 | |
   | 1 | ՌՌ Գրուպ Քոնսթրաքշն ՍՊԸ | 04248326 | 5 900 000 | |

3. The unmatched row got `resolved_tender_id` and `resolved_at`. Its two match jobs were run:
   both `skipped: status_awarded`, 0 notifications.

**bid-report is up**, and has been all along. It answers the request its own page sends, with
every filter field and an `order`; research.md's `{"status":500}` came from a bare filter and
`order: null`. The first run made 583 asks, which gave 582 stored answers, 0 refusals and 1
timeout. **Unavailable** was checked against a local fake PPCM answering `{"status":500}` to
everything: the repair job completed with `unavailable`, stored nothing, and the row stayed
`no_candidate`, `was_public` unchanged. The sweep's day jobs never call bid-report, so they
cannot fail for it.

**Idempotent.** A second run of the whole window: 455 of 455 answers unchanged, 0 stored, 0
bid-report asks (claimed), 0 repair jobs. 688 of the 689 rows were re-seen with `last_seen_at`
moved, all 689 refs are distinct, and the one linked ARMEPS procedure was not rewritten.

**Nothing else moved.** Content checksums with the repaired tender's own rows excluded:
`tenders`, `tender_sources`, `awards`, `public_tender_bids`, the non-PPCM `unmatched_results` and
`source_payloads` are byte-identical to the baseline. `parties` gained the tender's 4 (its buyer
and 3 `ppcm:bo:` bidders). Of the existing 994, **272 e-auction bidders gained their ՀՎՀՀ**:
ticket 11's write, now reached through the sweep for the 217 linked e-auctions (0 on the second
run; 2 shared ՀՎՀՀ reported, not merged). No alert was raised.

**The queue was put back.** The two runs queued 570 `armeps-repair-*` page fetches. One was
run (above) and **the other 569 were removed** (see *For the owner*). The repaired tender's
`armeps.documents` job is left queued, as for any ARMEPS tender.

## Decided while building

- **By announcement day, per form, every day of a 90-day window.** Every row of a procedure
  shares its announcement, so a day's answer holds whole procedures, and each goes through the
  ask by code's own `recordProcedure`, writes included. A page of 1,000 is served, so a day is
  one request (busiest: 291 rows). A date filter is `"from,to"`, inclusive; `p_form` is exact.
- **Single source is not swept.** It is never a miss (ticket 31), and «Մեկ անձ» is half of every
  procedure filed.
- **A miss is `no_candidate` and `was_public` true.** `was_public` is ticket 31's, from gnumner's
  listings and covered window, plus one new fact, `armepsPage`: bid-report names the procedure's
  armeps.am CfT, not paper-based, so it was announced whether or not gnumner listed it. The
  stored bid-report answer is read back by every later read of the procedure, so the answer is
  the same on every read. An e-auction is `null` unless gnumner listed it, so e-auction misses are not counted
  yet (see *For the owner*).
- **bid-report is matched by opening day**, not `datePublished`. `cftTendersOpeningDate` fell on
  the report's `t_opening_date` day for 86 of 86 entries, while `datePublished` equalled the
  announcement for only 29 (the rest are a later re-publication). The first run used
  `datePublished` and found only 184 pages; the fix found 563 from the same stored answers, with
  no new request. With no opening, the announcement is matched against `contractNoticeDate`
  (85 of 86).
- **The repair is its own job (`ppcm.repair`), one per code per day**, claimed in Redis
  (`ppcm:cft:{code}`) before it is queued. Inline, on the shared budget, most asks would be
  throttled and skipped. As a job, throttled is delayed, refused completes, and a timeout
  retries.
- **A PPCM row that is not an auction is `channelUnstated`.** PPCM lists paper procedures too, so
  a code Tendra holds only on paper or e-auction is `other_channel`, not a missed ARMEPS tender.
  This also corrects ticket 10's ask by code, where a paper tender of the code was
  `no_candidate`.
- **e-auction procedures with no candidate (or two) are unmatched rows**, also on the ask by code
  (ticket 11 only logged them). One that attaches resolves its row.
- **PPCM's link id stays `{code}@{announced}`.** ADR 0004 named the `resourceId`; most PPCM links
  never learn one. The ADR has a short amendment.
- **Created ARMEPS and e-auction tenders re-ask PPCM** for every unmatched procedure of their code
  (`queuePpcmRetries`, at the results priority). The ask is one request, then resolution from
  memory, since the tender holds no PPCM link.
- **No migration.** `unmatched_results` already had every column. Ticket 30's scheduler step now
  names `missed-ppcm`.

## Review (`/code-review`, standards and spec)

Fixed from it, then checked live:

- **`was_public` flipped back.** Only the sweep read bid-report's stored answer, so an ask by code
  (`refresh-ppcm`, or a retry) that left the procedure unmatched wrote `was_public` back to what
  gnumner alone says, until the next sweep set it again. Every read of a `no_candidate` ARMEPS-form
  procedure now reads the stored answer; only the sweep queues anything. Checked live: an ask by
  code for ԵՔ-ԳՀԽԾՁԲ-26/114 kept `true`.
- **A repair page was re-queued on every sweep**, and under a fixed id, so a fetch that failed
  could never run again. The page now has its own claim (`ppcm:page:{resourceId}`,
  `repairPollHours`) and the id carries the hour. Checked live: one sweep day run twice gave
  `page_queued`, then `page_asked_recently`.
- **The repair job's dates were not validated on dequeue.** A bad date is now unrecoverable,
  rather than a retried `RangeError`.
- **The forms left out are written down.** Every other form in `get-form-list` had 0 rows in the
  year to 2026-10-27, except grants (1,924), which no supplier bids for.

Left, on purpose:

- **Code-less rows are counted and logged, not stored.** No row names a procedure anything could
  be matched to. There were 0 in 90 days.
- **`publicityOf` stays in `paper.js`**, exported. It reads the gnumner board's watermarks, and a
  service importing a worker would be the worse direction.
- **`ppcm.js` is not split.** The store-if-new block is repeated in its three handlers, and their
  orderings differ on purpose: an answer by code or by day is recorded after its procedures, a
  bid-report answer before.
- **Earlier tickets' behaviour changed** (listed under *Decided while building*): ticket 10's
  paper-held code is now `other_channel`, ticket 11's e-auction misses are now rows, and ADR 0004
  has an amendment for the owner to read.

## For the owner

- **The first `missed-ppcm` run is a 90-day ARMEPS backfill.** Locally it found 563 public
  ARMEPS tenders Tendra never had, and queues their armeps.am pages: about 560 tenders, each with
  its document archive queued. On Neon it will do the same. The 569 queued here were removed
  because the archive backfill is yours to start; the next sweep queues them again from the
  stored answers, with no bid-report request. Shorten `missedSweep.windowDays`, or let it run.
- **The future operator alert will see 563 "misses" on its first day.** They are real (public,
  absent), and repairs resolve them within hours of the pages being fetched. A first-run
  exemption, or alerting only on misses older than a day, is that feature's call.
- **e-auction misses are not counted.** 106 e-auction procedures have no tender and `was_public`
  null, because ticket 31's rule leaves an e-auction unknown unless gnumner listed it. Every
  e-auction is public on eauction.armeps.am, but proving Tendra was watching *then* needs an
  eauction coverage window, which no sweep records today. Locally they predate the import.
- **Load:** about 455 report requests a day, plus one bid-report ask per unmatched competitive
  code a day, on armeps.am's budget at `PRIORITY.RESULTS`. That budget is the uncommitted 22/min
  in `sources.config.js`, left alone.
