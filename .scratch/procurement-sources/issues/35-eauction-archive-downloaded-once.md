# 35 — Download an e-auction invitation archive once, not on every status change

**What to build:** The document stage asks eauction.armeps.am for a tender's invitation archive
only when Tendra has not stored one for that tid yet.

**Blocked by:** None.

**Status:** done

Found 2026-10-29, while working out what a local worker would do with its backlog. `ingest.fetch`
holds 1,453 `tender.documents` jobs, and **1,108 of them are for tids whose archive is already in
MinIO**. Only 345 are new.

`eauctionDocumentsJob` (`workers/documents.js`) queues a job on every tender event. Its job id,
keyed on the invitation URL, dedupes only while a job with that id still exists. Once a job
completes, the id is free again. A tender walks Հրապարակված → Նախաաճուրդային → Աճուրդ → Շնորհում →
Ավարտված, so its archive is downloaded about five times. The content-hash check in the handler
only skips the storage write; by then the request has been spent out of the e-auction budget it
shares with discovery.

Ticket 27 found that an e-auction invitation is written once and never re-issued. An amendment is
a new tid (ticket 29), so it has its own ref.

## Acceptance

- [x] **Skip the download when the tid already has an archive.** Before the request, if
      `source_payloads` holds any `invitation:{sourceId}` row for that source, end the job as
      `already_stored`. Nothing is fetched.
  - A job carrying `amendment` still raises its owed alert, as the handler already does for an
    archive already stored.
  - The document follow-ups a stored archive triggers today must still happen if they depend on
    this job: the manifest, the lots, the CPV, the re-match of an open tender (ticket 25), and the
    buyer's ՀՎՀՀ. Check each one. Record which of them run from the job, and which from the
    stored row.
- [x] **Or skip queueing the job at all,** if the producer can know without a new query in the
      normalizer's hot path. Choose one, and say why. *The handler, see* Built.
- [x] **ARMEPS is out of scope.** Its document set is re-issued (addenda, ticket 18), so it must
      keep downloading. *Untouched: ARMEPS has its own job (`armeps.documents`,
      `workers/armeps.js`) and never reaches this handler; all 1,453 queued
      `tender.documents` jobs are e-auction's.*
- [x] **Verify by hand on the local queue**, with no live request:
  - run the handler in process on one stored tid and one new tid, with HTTP stubbed;
  - the stored tid makes 0 requests;
  - the new tid makes 1 request.
- [x] **Record how many of the 1,453 queued jobs would now be skipped.** *959. See*
      Verification.

## Built

`workers/documents.js#storeInvitation` returns `{ skipped: 'already_stored' }` when
`source_payloads` holds a row for `invitation:{sourceId}`. The check runs after the
`downloadDocuments` and origin checks and before `fetchDocument`, so the rate limiter is
never asked. It is one lookup on `(source, ref)`, the prefix of the table's unique index.

**Why the handler, not the producer.** The producer, `eauctionDocumentsJob`, runs inside every
normalize, so knowing there would be a new query in the hot path, which the ticket rules out.
There is no cheaper signal. `result.event === 'TenderIngested'` alone, meaning queue on
creation only, would also lose the retry: today each later status change re-queues the job, and
that is the only automatic retry, `npm run documents:backfill` aside, for a tid whose download failed for good (a final attempt,
documents disabled at the time, a crash). In the handler, a stored tid costs a queue slot and
one indexed read, and an unstored one keeps its retries.

**The follow-ups.** None of them depended on a repeat job:

| follow-up | where it runs |
|---|---|
| manifest (`tender_documents.manifest`) | the job that first stores the archive (`manifestOf` over the bytes) |
| lots, CPV codes, buyer's ՀՎՀՀ | the same job, through `AddendumService.recordDocuments` (`applyInvitationFacts`) |
| open tender's re-match (ticket 25) | the same job, in `recordDocuments` (`match-{id}-docs-…`, keyed on the archive) |
| checklist text (`.txt` beside the archive) | the same job |
| the `invitation:` row itself | the same job, **last**, after all of the above |

The row is written last, so a row means everything above already ran. A crash before it
leaves no row, and the next job downloads again. A repeat download used to end at the
content-hash check (`unchanged: true`) and run none of these again, so skipping before the
request loses nothing that ran. The stored row does not trigger any of them later.

**The owed amendment alert.** `already_stored` is a result with no `amendmentRaised`, so
`handleTenderDocuments` raises the join's alert without the file list. That is exactly what the
old `unchanged` result did. None of the 1,453 queued jobs carries an amendment.

The content-hash check stays, for two jobs of one tid that both pass the new check while
neither has stored yet. One shared job id rules that out within a queue, so it can only happen
between `ingest.fetch` and `ingest.backfill`; `record()`'s unique constraint decides it.

The skip uses `sourcePayloads.existsByRef`, a new predicate beside `existsWithHash` (review).

## Verification (2026-10-29, local queue, Postgres `tendra` and MinIO, no request made)

The queue was read, never drained or changed. `eauction/client.js` was replaced by a loader
hook with a stub that counts each `fetchDocument` call and then throws, so nothing could be
fetched or written.

```
queued tender.documents: 1453 (all eauction, 1453 distinct tids, 0 carrying an amendment)
  959  invitation: row in source_payloads   → skipped, 0 requests
  149  archive in MinIO, no row             → downloaded (one last time, see below)
  345  new                                  → downloaded

stored tid 48187 → {"skipped":"already_stored"}            requests: 0
new tid 46755    → StubRefused (tender_46755.zip requested) requests: 1
```

**Why 959, not the ticket's 1,108.** The ticket counted tids whose archive is in MinIO; 959 +
149 = 1,108. The 149 hold a `tender-docs/eauction/{tid}/` object but no `source_payloads` row
and no `tender_documents` row. These are ticket 27's side finding: leftovers of an earlier
database, whose tids came back through the sweep.

- Their tenders have no lots, CPV or ՀՎՀՀ from the archive.
- So the one download each still makes does real work. After it, the row exists and the
  skip holds.

## For the owner

- **`documents:backfill` is idempotent only while a tender's invitation URL never changes.**
  It selects tenders whose `tender_documents.url` is not the current `invitation_url`. Such a
  tender would be queued on every run and skipped every time, since its tid is stored. There
  are 0 today, and an e-auction URL is `public_invitation/tender_{tid}.zip` (found in review).
- **The 149 could be filled from storage instead.** That would save 149 requests, one time
  only. It means trusting a `tender-docs/` object no row vouches for. `npm run reindex`
  rebuilds rows from `raw/` only, so nothing reads these objects today. Not built.

