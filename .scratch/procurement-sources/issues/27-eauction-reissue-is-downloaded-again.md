# 27 — A re-issued e-auction invitation is downloaded again

**What to build:** When a buyer re-issues an open e-auction tender's invitation (adds an
amendment notice, replaces a specification), Tendra downloads the new archive, so ticket 18's
addendum rule can see it and suppliers are told. Today they almost never are. Found while
measuring for ticket 18 on 2026-10-20.

**Blocked by:** None. Ticket 18 is done; the rule already applies to e-auction once a second
archive is stored.

**Status:** done

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

- [x] Find out on a live tender whether an invitation re-issue changes the e-auction detail page
      (a new link, a date, a status). Record it here. **There is no in-place re-issue to find.**
      An e-auction amendment is a new tender. See *Outcome* below.
- [x] Open e-auction tenders have their invitation re-checked on a schedule… **Not built, by
      decision (2026-10-20).** It would cost 728 requests a day and, on the evidence below,
      never find anything. Its cost and the server's conditional-request support are recorded
      below, for the day a source does rewrite a file in place.
- [x] A re-check of an unchanged invitation writes nothing. Already true: byte-hash dedupe. The
      server would not even send the bytes (304).
- [ ] ~~Verified by hand on one real re-issue~~. No in-place re-issue exists to verify. The real
      mechanism is ticket 29.

## Outcome (2026-10-20)

**An e-auction invitation is written once, at publication, and never again.** All 266 open
e-auction invitations were checked with a HEAD request, 3 s apart. Every `Last-Modified` fell
within 10 minutes of the tender's `published_at`, and none was later than our download. 0 of 266
had changed.

**An amendment is published as a new tender with a new tid**, and the original disappears:

- The replacement's detail page carries a block «Աճուրդի սկզբնական հրավեր(ներ)» (initial
  auction invitation(s)): a table of code, publish time and a link to every predecessor tid.
  Example: 48185 (published 2026-10-16 16:44, deadline 10-27) links to 48159 (published
  11:26 the same day, deadline 10-26). Both carry code `ՌՀԱԲԿ ԷԱԱՊՁԲ 27/02`. Some link two
  predecessors (46964 → 46826, 46963), which is an amendment of an amendment.
- The original's page says **Կարգավիճակ: Փոփոխված** (amended). `detail.parser.js#STATUS` has
  no mapping for that label. The original's own invitation file is unchanged: 48159's
  `Last-Modified` is still its publish time.
- **The public listing hides Փոփոխված tenders.** Listing page 3 runs from 48177 to 48147 and
  skips 48159. So the original stops being reachable by the sweep the moment it is amended.
- `popoxutyan_pastatuxt.*` (the amendment notice) is the replacement's archive, not a re-issue
  of the original's. In the local database: every one of the 84 archives holding it belongs to
  a tender whose page links a predecessor. There are 90 such replacement tenders, linking 113
  predecessors, and **none of the 113 is in the database**. Local ingestion started after they
  were amended, and the listing never showed them again.

**So ticket 18's addendum rule never fires for e-auction**, and that is correct: no tender ever
gets a second archive. What goes wrong is elsewhere. With a live sweep running continuously, an
original *is* ingested while it is Հրապարակված, and then:

- it stays `active` with the old deadline and old documents, because no sweep sees it again;
- after the deadline, `tender.refresh` reads Փոփոխված. That label is unmapped, so status
  degrades to `closed`, which is non-terminal, so the tender is re-read hourly for
  `refreshWindowDays` (30) and wastes about 720 requests;
- an organization tracking it gets no amendment alert (ticket 28 cannot help, because no
  amendment is raised);
- the replacement arrives as a separate new tender. A saved search hears of it as new; a
  tracker of the original does not.

That is ticket 29.

**Cost of the schedule as specified, measured, not built:**

| | |
|---|---|
| Open e-auction tenders (status `active`/`amended`, deadline ahead) | 182 |
| Rows with status `active` regardless of deadline | 267 |
| Requests/day at every 6 hours | **728** (1,068 counting every `active` row) |
| Budget (`rateLimit` 20/min, the ticket's figure) | 28,800/day; at the uncommitted 32/min, 46,080 |
| Cost of an unchanged invitation | one 304, 0 bytes |
| Changes it would have found today | 0 of 266 |

**The invitation host (nginx) honours conditional requests.** Its headers are `ETag`
(`"690c2-65df6dc339902"` form), `Last-Modified`, and `Accept-Ranges: bytes`. Both
`If-None-Match` and `If-Modified-Since` answer `304` with an empty body, and a stale `ETag`
answers 200 with the full file. `utils/http.js#fetchPage` already sends both headers when given
them; `fetchDocument` does not pass any today.

Side finding, not this ticket: of the 396 archives without a `source_payloads` row (ticket 14
called them "older content hashes of a re-issued invitation"; they are not), 332 belong to no
tender in the database, and 64 to tenders (45 awarded, 17 cancelled, 2 closed) with no
`tender_documents` row. `npm run documents:backfill` picks up the 64 (no document row); the 332
are leftovers of an earlier database.
