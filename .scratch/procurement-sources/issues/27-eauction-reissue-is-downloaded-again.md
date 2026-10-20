# 27 — A re-issued e-auction invitation is downloaded again

**What to build:** When a buyer re-issues an open e-auction tender's invitation (adds an
amendment notice, replaces a specification), Tendra downloads the new archive, so ticket 18's
addendum rule can see it and suppliers are told. Today they almost never are. Found while
measuring for ticket 18 on 2026-10-20.

**Blocked by:** None. Ticket 18 is done; the rule already applies to e-auction once a second
archive is stored.

**Status:** ready-for-agent

**Triage (2026-10-20):** the ticket is right as written. One preference and one budget:

- **Prefer the signal.** If a re-issue visibly changes the detail page, carry that change in the
  document job id. That is zero extra requests.
- **Otherwise, a scheduled re-check of open tenders only**, using a conditional request
  (`If-None-Match` / `If-Modified-Since`) if the static file's server honours it, so an
  unchanged invitation costs a 304.
  - Record whether it does. Start at every 6 hours.
  - With about 270 open e-auctions, that is about 1,100 requests a day against a budget of
    28,800, and it is never allowed to delay live sweeps (`PRIORITY` below `LIVE`).
  - Record the measured figure.

What ticket 18 measured (local `tendra` database and MinIO bucket):

- 1,483 stored e-auction archives in 1,483 tender folders. **No tender has two**, so no
  re-issue has ever been stored.
- 84 of 1,087 recorded archives (7.7%) already contain `popoxutyan_pastatuxt.*`, the amendment
  notice. Re-issues happen; we only ever hold the copy we downloaded first.
- The invitation is a static file at a fixed URL (`public_invitation/tender_N.zip`). Three open
  tenders re-downloaded two days later were byte-identical to the stored copy.

Why a re-issue is missed:

- `workers/documents.js#eauctionDocumentsJob` runs only on a changed detail page
  (`result.event`), under the id `eauction-docs-{sourceId}-{sha(invitationUrl)}`. The URL never
  changes, so the id never changes. BullMQ keeps a completed job for 24 hours, so a second
  download happens only if the detail page changes more than a day after the last one.
- It is unknown whether a re-issue changes the detail page at all. If it does not, nothing ever
  re-downloads it.

Acceptance criteria:

- [ ] Find out on a live tender whether an invitation re-issue changes the e-auction detail page
      (a new link, a date, a status). Record it here.
- [ ] Open e-auction tenders have their invitation re-checked on a schedule, within the 20/min
      budget, the counterpart of ARMEPS's refresh. Or, if the detail page does change on a
      re-issue, the document job id carries something that changes with it. Record which, and
      what it costs in requests per day.
- [ ] A re-check of an unchanged invitation writes nothing (byte-hash dedupe already does this).
- [ ] Verified by hand on one real re-issue: two archives stored, a new `version`, and one
      `TenderAmended` alert job naming the new file.

Side finding, not this ticket: of the 396 archives without a `source_payloads` row (ticket 14
called them "older content hashes of a re-issued invitation"; they are not), 332 belong to no
tender in the database, and 64 to tenders (45 awarded, 17 cancelled, 2 closed) with no
`tender_documents` row. `npm run documents:backfill` picks up the 64 (no document row); the 332
are leftovers of an earlier database.
