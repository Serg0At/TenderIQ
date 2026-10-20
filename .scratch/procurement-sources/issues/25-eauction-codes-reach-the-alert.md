# 25 — An e-auction tender's CPV codes reach its alert

**What to build:** A supplier whose saved search names a CPV code an e-auction tender states hears
about that tender when it is published, not only if a keyword happens to hit. Found in ticket 17:
an e-auction detail page carries no CPV — the codes live only in the invitation archive — and the
normalizer queues the `match.tender` job and the `tender.documents` job **at the same moment**.
The match runs on the alerts queue at once; the archive download waits on the 20/min politeness
budget. So the matcher reads a tender with no code at all, finds no CPV match, and nothing
re-runs it once the codes land: `applyInvitationFacts` raises no event.

**Blocked by:** None — ticket 17 is done.

**Status:** done

**Decided 2026-10-20: re-run the match when the codes first land. Do not hold the ingest match.**

- Holding it would delay every e-auction alert by the archive queue's wait, against NFR-PERF-4. The
  local fetch queue held a 1,534-job document backlog this week.
- Worse, a download that fails for good would mean **no alert at all**, so a supplier who would
  have been alerted by keyword loses that too. Re-matching only ever adds: the first match keeps
  its speed, and the second catches what codes add.
- Notification dedupe makes the second run silent for an organization already alerted.

The decisions below are therefore settled as follows:

- **Trigger:** the document stage writes a code list where the tender had none ("first land").
  A later change of codes is an amendment and goes through that path, not this one.
- **Event and job:** `TenderIngested`, so the organization gets a `tender-match` for a tender it
  has never heard of, under its own job id (for example `match-{id}-codes`), distinct from
  `match-{id}-v{version}`.
- **No alert on old tenders, guarded twice:** the tender must be alertable at the moment of the
  re-match (`ALERTABLE_STATUSES`, deadline not passed). This alone keeps `documents:backfill`
  and the archive seed silent, since their tenders are long closed. Also, a job enqueued at
  `PRIORITY.BACKFILL` never re-matches. Record both in the verification.

Measured on the local `tendra` database and Redis, 2026-10-20: of 851 e-auction `match-…-v1`
jobs in `bull:alerts`, 787 had a stored invitation and **all 787 were queued before it was
stored** (0 the other way round; the other 64 have no invitation). For an e-auction, a CPV-only
saved search has effectively never fired at ingest. A later `TenderAmended` carries the codes, but
the status moves that amend an e-auction (Նախաաճուրդային, Աճուրդ, …) are not alertable, so that
does not rescue it. ARMEPS is not affected: its page states its codes, and ticket 17 puts every
one of them on the tender before the match runs (lot codes still arrive later, with the
documents, but every lot code is also on the page).

Decisions this needs, not taken here:

- [x] When the codes first land (the document stage writes a code list where there was none),
      re-run the match for the tender. Under which job id — `match-{id}-v{version}` is already
      taken by the ingest match, and BullMQ keeps a finished job's id — and as which event:
      `TenderIngested`, so the organization gets a `tender-match` and not an `amendment` for a
      tender it never heard of. Notification dedupe already makes a second run silent for an
      organization that was alerted by keyword.
- [x] **A backfill must not alert on old tenders.** `documents:backfill` and the archive seed
      write invitation facts for tenders published long ago; only a live ingest (not
      `PRIORITY.BACKFILL`, not a status that is no longer alertable) may trigger the re-match.
      Record how that is told apart.
- [x] ~~Or the alternative: hold the ingest match until the documents stage has run (or failed for
      good) for sources whose page states no CPV. That delays every e-auction alert by the
      archive's queue time against NFR-PERF-4 (< 5 min after ingestion); record which is chosen
      and why.~~ Not chosen — see *Decided 2026-10-20* above.
- [x] Verified on the local database with a throwaway saved search on a code that only an
      invitation states: published → documents stored → one `tender-match` notification, and a
      replay or a `documents:backfill` run raises none.

## What was built — 2026-10-20

- `tender.repo.js#applyInvitationFacts` returns `codesLanded`: codes parsed and the tender's stored
  `cpv_codes` blank before this write. Codes are only ever replaced by a non-empty list, so this is
  true at most once per tender.
- `addendum.service.js#shouldRematchOnCodes` (pure): `codesLanded`, not `PRIORITY.BACKFILL`, and
  `isOpen` — the same alertable-status-and-deadline rule the addendum alert uses. When it holds,
  `recordDocuments` queues `match.tender` `{ event: 'TenderIngested', version }` under
  `codesMatchJobId(id)` = `match-{id}-codes` (`queues/names.js`), at the job's own priority.
- ARMEPS passes no `cpvCodes` to the document stage (its page states them), so it never triggers.
- Known and accepted, as with the addendum's windows: a crash between the commit and the enqueue
  loses the re-match, since the retry finds the codes already there. The ingest match's alerts are
  unaffected.
- Two edges, both rare and accepted: a first set that parsed no codes followed by a changed one
  that does raises both the addendum's `amendment` and this `tender-match` (different types, so
  dedupe keeps both); and an open tender with `cpv_code` set but `cpv_codes` blank (one
  `cpv:backfill` has not reached) re-matches when its archive is next stored — deduped for any
  organization its ingest match already alerted.
- A replay only reaches this if a parser change makes it raise an event for an open e-auction
  tender with no stored archive; that one would re-match at LIVE, which is the decision's intent (an
  open tender nobody was CPV-matched on).
- No test runner exists (CLAUDE.md), so the verification below is the check, as for ticket 18.

## Verification — 2026-10-20

Against the local database `tendra`, the local MinIO bucket and the local Redis. No worker was
running. The handlers ran directly (`handleTenderDocuments`, `handleTenderMatched`,
`normalizeTender`); the invitation was fetched from the source through the production client and
rate limiter. Local `tendra` had no saved searches and no live channel subscriptions, so nothing
could be delivered anywhere; a throwaway organization with one saved search, `cpv_codes:
['31161110']` and no keywords, was created and deleted afterwards.

Tender `eauction:48112` (`yc48ii1eicbq617wp3ogbbnz`, active, deadline 2026-11-02, v1, one code,
`31161110`, which only its invitation states), reset to "just published": no codes, no lots, no
document row, no invitation payload.

| step | result |
|---|---|
| 1. ingest match, before the archive | 1 profile, **0 matched**, 0 notifications — the bug |
| 2. documents stage, `PRIORITY.LIVE` | `codesLanded: true`; queued `match-yc48ii1eicbq617wp3ogbbnz-codes`, `TenderIngested`, v1, priority 1 |
| — that job, run | 1 matched, **1 `tender-match`** (subject NULL), delivered to the org's `log` default |
| — the same job re-run (a retry) | 0 notified; still 1 notification (dedupe) |
| 3. replay: `normalizeTender` on the latest `detail:48112` payload, `normalize:replay`'s job data | `event: null`; no alert job, no document job (fetch queue delta 0) |
| — documents stage re-run | `{ unchanged: true }` (content hash); no codes job |
| 4. reset again, documents stage at `PRIORITY.BACKFILL` on the **open** tender | `codesLanded: true`, **no codes job** — the priority guard on its own |
| tender after | `cpv_code`, `cpv_codes`, 1 lot, v1, `active` — as before |

`documents:backfill`, on its real jobs: the fetch queue held 500 `tender.documents` jobs at
`PRIORITY.BACKFILL`; 64 of them for tenders with no codes yet (45 awarded, 17 cancelled, 2
closed). Three were run through the handler and removed from the queue:

| tender | status | codes landed | codes job |
|---|---|---|---|
| `eauction:46862` | cancelled | `09132200` | none |
| `eauction:46870` | awarded | `92111210` | none |
| `eauction:46905` | awarded | `09132200` | none |

The status guard on its own: `eauction:47781` (closed, ten codes), reset and run at
`PRIORITY.LIVE` — `codesLanded: true`, **no codes job**; its ten codes were restored by the run.
