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

**Revised the same day, after review (owner's decision):** the trigger is broader and the priority
guard is gone. The bullets below are struck where they no longer hold.

- **Trigger: an open tender's archive is stored.** Not "codes first land": that needs a "were there
  codes before?" check, and a crash between the commit and the enqueue fell between it and the
  retry, which found the codes already there. Storing an archive of an open tender → match has no
  such state; the retry re-matches and dedupe absorbs the duplicate. It is cheap (an archive is
  stored once per tender, plus the rare re-issue) and works with ticket 27: a re-issue with new
  codes alerts newly matching organizations with a `tender-match`, while its addendum goes through
  the amendment path ticket 18 built.
- **One guard: the tender is open.** The backfill-priority guard did no work the open-tender guard
  does not already do — what the archive seed and `documents:backfill` store is long closed — and
  it did harm: a failed live download recovered by `documents:backfill` on a tender still open is
  exactly the missed tender this ticket exists to catch, and it silenced that.

The original decisions, as triaged:

- ~~**Trigger:** the document stage writes a code list where the tender had none ("first land").
  A later change of codes is an amendment and goes through that path, not this one.~~ Revised.
- **Event and job:** `TenderIngested`, so the organization gets a `tender-match` for a tender it
  has never heard of, under its own job id, distinct from `match-{id}-v{version}` — built as
  `match-{id}-docs-{sha256(storage key)[:12]}`, one per stored archive.
- **No alert on old tenders, guarded twice:** the tender must be alertable at the moment of the
  re-match (`ALERTABLE_STATUSES`, deadline not passed). This alone keeps `documents:backfill`
  and the archive seed silent, since their tenders are long closed. ~~Also, a job enqueued at
  `PRIORITY.BACKFILL` never re-matches.~~ Revised: removed. Record both in the verification.

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

- `AddendumService.recordDocuments` (`services/addendum.service.js`): after the transaction that
  records a document set, if the tender is open (`isOpen`: an alertable status and a deadline
  ahead or none — the rule the addendum alert already uses), it queues `match.tender`
  `{ event: 'TenderIngested', version }` under `documentsMatchJobId(id, storageKey)` =
  `match-{id}-docs-{sha256(storageKey)[:12]}` (`queues/names.js`), at the document job's priority.
- That method is reached only for a new archive identity — e-auction's content hash, ARMEPS'
  `documentSetHash`, both checked against `source_payloads` before it is called — and the storage
  key names that identity. So it is one match per stored archive: a retry reuses the id (BullMQ
  drops the add while the finished job is retained, notification dedupe after that), and a
  re-issue gets its own.
- Both sources: ARMEPS sets stored for an open tender re-match too. Their lot names arrive with
  the documents, so a keyword on a lot name now fires there as well; otherwise dedupe keeps it
  silent.
- When an addendum and a re-match fall on one set, both are queued: the `amendment` for
  organizations already matched, the `tender-match` for any the new set newly matches (different
  types, so dedupe keeps both).
- No test runner exists (CLAUDE.md), so the verification below is the check, as for ticket 18.

## Verification — 2026-10-20

Against the local database `tendra`, the local MinIO bucket and the local Redis. No worker was
running. The handlers ran directly (`handleTenderDocuments`, `handleTenderMatched`,
`normalizeTender`); every invitation was fetched from the source through the production client
and rate limiter. Local `tendra` had no saved searches and no live channel subscriptions, so
nothing could be delivered anywhere; a throwaway organization with one saved search,
`cpv_codes: ['31161110']` and no keywords, was created and deleted afterwards.

Tender `eauction:48112` (`yc48ii1eicbq617wp3ogbbnz`, active, deadline 2026-11-02, v1, one code,
`31161110`, which only its invitation states), reset to "just published": no codes, no lots, no
document row, no invitation payload.

| step | result |
|---|---|
| 1. ingest match, before the archive | 0 matched, 0 notifications — the bug |
| 2. archive stored, `PRIORITY.LIVE` | queued `match-yc48ii1eicbq617wp3ogbbnz-docs-dadae06eb9c0`, `TenderIngested` |
| — that job, run | **1 `tender-match`** |
| 3. crash before the payload row: payload row deleted, document stage re-run | the archive is stored again; the add is a no-op — still one job, same id, same timestamp |
| — the match run again | 0 notified; still 1 notification (dedupe) |
| 4. replay: `normalizeTender` on the latest `detail:48112` payload, `normalize:replay`'s job data | `event: null`; no match job, no document job (fetch queue delta 0) |
| — document stage re-run | `{ unchanged: true }` (content hash); no match job |
| 5. reset again; archive stored by a `PRIORITY.BACKFILL` job (a live download recovered by `documents:backfill`) | **queued** the same id at priority 10; run, 0 notified (already alerted) |
| tender after | `cpv_code`, `cpv_codes`, v1, `active` — as before |

`documents:backfill` on its real jobs: the fetch queue held ~500 `tender.documents` jobs at
`PRIORITY.BACKFILL`, 64 of them for tenders with no codes yet (45 awarded, 17 cancelled, 2
closed — none open). Six were run through the handler and removed from the queue; each stored its
codes and queued **no match**:

| tender | status | codes |
|---|---|---|
| `eauction:46862` | cancelled | `09132200` |
| `eauction:46870` | awarded | `92111210` |
| `eauction:46905` | awarded | `09132200` |
| `eauction:46834` | awarded | `63521200` |
| `eauction:46835` | awarded | six codes |
| `eauction:46836` | awarded | three codes |

(The first three ran under the first build, which also had the priority guard; the last three
under this one, where the open-tender guard alone kept them silent.)

The open-tender guard at live priority: `eauction:47781` (closed, ten codes), reset and stored at
`PRIORITY.LIVE` — **no match job**; its ten codes were restored by the run.
