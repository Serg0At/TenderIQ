# 09 — Failed procedures cancel ARMEPS and paper tenders

**What to build:** A supplier never sees a dead ARMEPS or paper tender as open. When gnumner
publishes a failed-procedure notice, the tender becomes `cancelled`. ADR 0004 status table.

**Blocked by:** 05, 06, 15

**Status:** done

- [x] The «Չկայացած գնման ընթացակարգի մասին հայտարարություն» listing is swept with watermark
      rules.
- [x] Each notice resolves to an ARMEPS or paper tender through the resolution module, and its
      link records `observed_status = cancelled`. e-auction notices are ignored (eauction owns that
      status).
- [x] *Derive status* sets `cancelled`. It never moves a tender back from `awarded`.
- [x] Partially failed procedures (some lots failed) do not cancel the whole tender. Record how
      the notice shows lot-level failure, and what is stored.
- [x] Unresolvable notices are unmatched results, and unreadable files count as
      `unsupported_format`.
- [x] Verified by hand on three real notices. Record them here.

## The listing and the notice

`chkayacats_gnman_yntacakargi_masin_haytararutyunner` (`listingPaths` entry `kind: 'failed'`):
6 notices a page, 4,568 pages, newest first. The first thirty pages (10-05 → 10-23, 180 notices,
so about ten a day) are **all uploads**: 74 `.docx`, 41 `.doc`, 38 `.pdf`, 21 `.rar`, 6 `.zip`.
25 are e-auctions (`ԷԱՃ` codes) and 23 titles name no code. No ARMEPS link was seen. The listing
also carries the odd non-failure title («… շահերի բախման բացակայության մասին», a
conflict-of-interest declaration, whose file here was the failure notice anyway; «… չեղարկելու
մասին», a `.pdf`). The content decides: a file without the template's table is not read.

**The template is MoF order 235-Ա (2022), Annex 13**, «ՀԱՅՏԱՐԱՐՈՒԹՅՈՒՆ գնման ընթացակարգը
չկայացած հայտարարելու մասին»: the code line, a sentence, then one table:

| Չափաբաժնի համար | Գնման առարկայի … | մասնակիցների անվանումները | չկայացած է հայտարարվել համաձայն … 37-րդ հոդվածի 1-ին մասի | հիմնավորում |
|---|---|---|---|---|
| 1 | Համակարգիչ ամբողջը մեկում | «ԼԱԳԱ 1820» ՍՊԸ … | 1-ին կետի 2-րդ կետի … | Մասնակիցների … չեն համապատասխանում … |

### How a notice shows lot-level failure, and what is stored

**The table lists the lots that failed, not the procedure's.** The sentence is unreliable:
Թ4ՊՈԼ-ԳՀԱՊՁԲ-26/34 keeps the template's «գնման ընթացակարգը չկայացած հայտարարելու» ("the procedure
is declared failed") over a table of lots 1–4, 25–32 and 39, and ՀՊՏՀ-ԳՀԱՊՁԲ-26/Գ-3 does the same
over lots 1–164 with 103, 144, 155 and 162 missing. Others edit it — «… 2-րդ չափաբաժնի մասով …»
(ՎԱ-ՍԱՏՄ-ԳՀԾՁԲ-27/10, lot 2) or «… 1-ին և 2-րդ չափաբաժինները …» (ՀՀ ՆԳՆ Կ ԳՀԱՊՁԲ-26/14) — and
list the same lots in the table. So only the table is read.

**Stored:** each notice is a `gnumner` link `failed:{digest of the upload path}`, role `results`,
`observed_status = 'cancelled'`, and **`tender_sources.failed_lots`**, the lots it named (a new
`integer[]` column, NULL on every other link). **The tender becomes `cancelled` only when its
notices, together, name every lot it has** (`tender_lots` ∪ the ledger's lots). A partly failed
tender keeps its status. Its other lots go on to a contract notice (`awarded`) or a failure
notice of their own, and the last one cancels it.

## Verification (2026-10-23, local Postgres `tendra`, MinIO, Redis `localhost:6379`, live gnumner)

No worker was running. Listing pages went through the production `readListingPage` with the
gnumner board. The jobs they queued were run in-process through `processIngestFetch` and removed,
`ingest.normalize` was drained by a normalize-only worker, and the matcher was run by hand.
Every request went through the `gnumner` rate limiter, with scripted fetches 3 s apart. Jobs
queued that were not part of a case were left queued, as tickets 04, 07 and 08 did. No test runner:
the pure rules are 42 assertions in a scratch script.

**Migration.** `migrations/add_tender_source_failed_lots.js` was run twice on `tendra`
(`failedLotsAdded: true`, then `false`) and mirrored into `create_table.js`. It is still on disk
for ticket 30, step 11.

**Pure rules (42 assertions, re-run after the review's fixes).**
- The lookup is the code in every channel.
- One paper or ARMEPS run announced before the notice → `link` (rule `code`). Announced after it
  → `no_candidate`.
- A re-announced code → the latest run before the notice. A re-announcement after the notice is
  not it. Two runs at one moment → `ambiguous`.
- A run still open when the notice was published → never it (`no_candidate`); a live
  re-announcement beside the run that failed → the run that failed. A run with no deadline →
  never it. A re-posted run whose files all postdate the notice → not it.
- Lots the latest run lacks → the older run that has them. Lots no run has → `no_candidate`. A
  run with no lots stored fits any.
- A code held only on e-auction → `skip other_channel`, also for an unreadable file. e-auction
  and paper → the paper one. An `ԷԱՃ` code Tendra holds nowhere → `skip`, even with
  `was_public` true; an `ԷԱՃ` code held on paper → the paper run.
- Unreadable → `unsupported_format`, never linked. No code → `no_code`. The title's code wins and
  the body's is used when the title has none. Already linked → rule `link`.
- `was_public`: `true` when the code was listed, `false` for single source, and never asked of
  the covered window. Never creates.
- `failureStatus`:
  - every lot → `cancelled`; some → unchanged;
  - an earlier notice's lots completing the set → `cancelled`;
  - lots not known, or none placed → unchanged;
  - `awarded` stays;
  - `active` before its deadline → `cancelled`;
  - ARMEPS `amended` → `cancelled` (gnumner owns it).
- The parser on the real files:
  - Թ4ՊՈԼ → 13 lots; ՎԱ-ՍԱՏՄ → [2];
  - bidder continuation rows are not lots;
  - ten blank lot cells → `[]` and 10 unplaced;
  - bilingual cells → [1, 2];
  - an Armenian `.doc` beside a Russian `.docx` → unreadable; a PDF-only zip → unreadable.

**The parser against the documents.** All 32 Word files downloaded (29 from pages 1–12 and 3
from pages 15–17) read exactly as their tables, dumped by hand. Lots «1» and «1.» are both seen.
Two files list rows with a blank lot cell (577dd5da: one «Դիզելային վառելիք»; 9bde87b6: ten food
items). They are counted and not read: the table lists only the lots that failed, so a row's
position is not its lot number. The five `.zip` files are unreadable: three hold only PDFs, and
two hold an Armenian `.doc` beside a Russian `.docx`. ԵԿԱ-ԳՀԱՊՁԲ-27/03's title names no code, so
its code came from the body.

**Nothing else moved.** Checksums of every domain table, then `npm run normalize:replay` over
all 1,230 stored payloads with the new code: 1,223 unchanged, 5 unmatched and 2 superseded,
**every checksum identical**.

### The listing, swept like ticket 08's

- **Cold start** (no watermark): 5 pages (`maxListingPages`), 35 `source_payloads` rows (5
  pages and 30 notices), 30 `paper.failed` jobs. The watermark is page 1's newest
  (2026-10-23T13:55:21Z) and the floor is 10-21T12:15:34Z. The floor only matters on invitation
  listings. The 30 jobs, run: **11 `no_candidate`, 17 `unsupported_format`, 1 `no_code`
  (577dd5da), 1 skipped `other_channel`** (ԵՊՀ-ԷԱՃԱՊՁԲ-26/186, a closed e-auction). None matched,
  because none of their tenders are in `tendra`.
- **Repeat sweep:** page 1, «reached the watermark», **0 rows, 0 jobs**.
- **The format-count query** (in `invitation.parser.js`, with the new `failed` kind) reports the
  failed notices as 7 `.rar`, 4 `.doc`, 4 `.zip`, 1 `.pdf`, 1 `.bin` and 1 unknown-procedure
  `.doc`. The `.bin` (ՄՍՇՊՀ-ԳՀԾՁԲ-26/48) starts `FF FE <html xmlns:v=…`: a Word document saved as
  UTF-16 web page. `fileFormat` calls it `unknown`, so it is counted, not mistaken for gnumner's
  HTML error page.

### By hand: three real notices, and two more

180 failure notices (pages 1–30) were matched against quotation pages 1–40 and open-tender pages
1–15. Four codes had their invitation on gnumner, all paper. Their invitations were read through
the chain from the quotation watermark, which did not move (quotation pages 30–32), and the
failure notices from the failed listing's watermark (pages 9–12 and 15–18).

| Code | Tender (as created) | Notice | What happened |
|---|---|---|---|
| **ԳՄՋՄԴ-ՀՄԱԱՊՁԲ-26/10** («ՀՀ Գեղարքունիքի մարզի Ջիլի միջնակարգ դպրոց» ՊՈԱԿ, diesel fuel) | `iz5td3ykdlgh92fawmi0mgs9`, published 10-08, deadline 10-13 11:30, lot 1, `closed` v1 | `26fbee78.docx`, 10-14; table: lot 1, «ոչ մի հայտ չի ներկայացվել» | **`cancelled` v2**; link `failed:9ec00460…` `cancelled`, `failed_lots {1}`; «lots 1 of 1» |
| **ՔԲԿ-ԳՀԾՁԲ-26/38** («Քրեակատարողական բժշկության կենտրոն» ՊՈԱԿ, vehicle insurance), run in the hard order | `kfxee55dgz5svkum7u6cmpag`, published 10-05, deadline 10-12 11:00, lots 1–6, `closed` v1 | `%20%20%20%2026.38.docx` (10-13 08:02) **before the tender existed** | `no_candidate`, **`was_public` true** (the code was on the quotation listing just read): a missed tender, as the operator alert would see it |
| | | `d75b7338.docx` (10-13 08:17), lots 1–6 | **`cancelled` v2**; «lots 1, 2, 3, 4, 5, 6 of 1, 2, 3, 4, 5, 6» |
| | | the 08:02 notice re-read from storage | linked (rule `code`), its unmatched row resolved to the tender; still v2, no event |
| **ԳՀԱՊՁԲ-ՀՎԿԱԿ-2026-69** (Disease Control Centre, vaccines) | `uzcig1lp2adeiisk6czx23jp`, lot 1, `closed` v1 | `d0e910ee.zip`: an Armenian `.doc` and a Russian `.docx` | **`unsupported_format`**, `was_public` true; the tender stays `closed` v1 |
| ՍՀՏ-ԳՀԱՊՁԲ-2026/20 (Sisian Community Transport) | none: its invitation is a `.rar` (`unsupported_format`) | `%20%20%202026.20.docx`, lot 1 | `no_candidate`, `was_public` true |

- **Idempotent:** all three linked notices re-read from storage twice. The second time every
  checksum is identical, with no version and no job.
- **Alerts:** `match-…-v2` for both cancellations → `skipped: status_cancelled`. The v1 ingest
  matches → `status_cancelled` / `status_closed`.

**Partial, then whole, on a real tender.** No live notice hits a multi-lot tender Tendra holds,
so two throwaway notices went through the production path (`findCandidates` → `resolve` →
`failureStatus` → `recordFailure`) against **ԵՊՊՔ-ԳՀԱՊՁԲ-26-3** (`a6an3qgjtwm5g2gmurv9pehx`,
lots 1–4, `closed` v4):

| step | result |
|---|---|
| notice A, lot 2 | linked, `failed_lots {2}`, **still `closed` v4, no event** |
| notice B, lots 1, 3, 4, with a stale view of the other notices (`expectedFailedLots: []`) | threw «has had failed lots recorded since it was resolved — re-resolve», nothing written |
| notice B again | others `[2]` + `[1, 3, 4]` = every lot → **`cancelled` v5, `TenderAmended`** |
| notice B once more | `cancelled` v5, no event |

The throwaway links were then deleted and status and version restored. The checksums went back to
identical.

## Decided while building

- **Only the table is read.** The sentence is the template's default, left in place over
  partial tables (above).
- **A notice cancels only when all the notices together cover every lot.** A cancellation is
  terminal (`deriveStatus` never moves out of it), so a wrong one would stop a later contract
  notice from awarding the lots that went on. A missed one leaves a tender past its deadline
  `closed`, which is not shown as open either.
- **No lots known, no cancel.** 36 of `tendra`'s 54 ARMEPS tenders and 3 of 18 paper tenders have
  no stored lots, because their document jobs are still queued locally. A notice cannot prove it
  named every lot of such a tender.
- **Rows with a blank lot cell are not read**, as in ticket 08: a lot is read only when the table
  places it. Numbering by position, as the invitation parser does, would be wrong here because
  the table holds only the failed lots.
- **Matching:** the notice states no invitation date, so rule 3's date cannot be asked. It
  matches the tender of its code **announced before it and past its deadline when it was
  published, the latest**. A failure is declared after bids open, and a buyer re-announces a
  code after its run failed (ADR 0004's re-announcements follow cancellations within days).
  So a run still open, such as a re-announcement read beside its predecessor's late notice, is
  never cancelled. Two at one moment → `ambiguous`. Lots that contradict rule a run out.
- **Channels:** ARMEPS and paper candidates both. An e-auction's notice is skipped before the
  format is asked, so its `.pdf` is never an unreadable paper result. That covers a code held only
  on e-auction, and an `ԷԱՃ` code with no ARMEPS or paper tender: otherwise every e-auction older
  than Tendra's history would be a `no_candidate` that reads as a missed tender.
- **`was_public`** asks only whether the code was ever listed. Asking the covered window would
  use the failure notice's own publication as the invitation's day and could say `false` for a
  public procedure.
- **Race guard:** `recordFailure` re-reads the other notices' lots under the row lock and throws
  if they moved, as `recordResults` does for the status.
- **Keyed by upload path** (`failed:{digest}`), as a contract notice is, so it can be rebuilt
  from its stored listing page.
- **The armeps-link guard** on the contract listing now covers the failed listing too: a
  link would re-read the armeps.am page, which states no status.
- **Migration:** `tender_sources.failed_lots integer[]` (ticket 30, step 11).

## Review (`/code-review`, standards and spec)

Fixed from it. Afterwards the pure checks (42), the parser snapshot, every stored failure notice
re-read from storage, the three real ones resolved again under fresh ids (each → `link`, rule
`code`, its tender), the ԵՊՊՔ partial case and a full `normalize:replay` (1,234 payloads) were all
re-run. Checksums were identical throughout.

- **A late notice could cancel a live re-announcement.** "Latest announced before the notice"
  did not ask whether the run was still open, and a re-posted run (`replacedRuns`) skipped even
  the publication check. Now a run must be past its deadline when the notice was published.
- **An e-auction Tendra never held became a "missed tender".** A code held nowhere was
  `no_candidate` with `was_public` true (gnumner's e-auction items are in `listing_notices`).
  An `ԷԱՃ` code with no ARMEPS or paper tender is now skipped.
- **A partial notice's link says `cancelled`.** This is harmless while status is derived per
  observation, but a later derivation across links would cancel every partly failed tender. A
  comment in `observeFailure` says so.
- **Duplicated helpers.** `armenianPart`, `isBlank` and the two script regexes moved into
  `word.js` from `contract.parser.js` and `failed.parser.js`. Both parsers' output over every
  stored notice (31 contract, 35 failure) is byte-identical before and after.
- A no-op `publishedAt: null` in the `wasPublic` call was removed.

Not changed:
- **`recordFailedNotice` repeats `recordContract`'s tail, and `recordFailure` repeats
  `recordResults`' lock-and-check head.** That is the fourth copy of the idiom. Folding them is a
  refactor of existing code, as tickets 06 and 08 said.
- **The other notices' failed lots are defined twice:** in SQL for candidates and in
  `failedLotsOf` under the lock. Both are distinct and ascending. They are compared to detect a
  race, and folding them would cost a query per candidate.
- **The `failed_lots` subquery runs for every candidate of every source.** It is indexed by
  tender, and the replay's timing did not move.
- **The body's code is read by the failure parser's own `readCode`**, not `noticeBodyCode`, as
  the contract parser does: each template parser reads its own code line, and the file is
  opened once.

## Left, on purpose

- **No re-read when a tender of its code appears later**, unlike a contract notice. The tender it
  ends was announced before it, so the invitation sweeps reach it first. The exception is a tender
  older than a cold start's pages, or one whose invitation failed and was retried after the notice
  was read. Such a notice stays `no_candidate` with `was_public` true, which reads as a missed
  tender (as the 08:02 ՔԲԿ notice did, until it was re-read by hand). If the operator alert finds
  these, extending `queueContractRetries` to `failed:` rows is the fix.
- **A failure notice after a contract notice for the same lots** is linked and changes nothing
  (`awarded` is terminal). Nothing compares the two.

## For the owner

- **No ARMEPS tender was seen on this listing.** All 180 notices were uploads, and none of their
  codes was an ARMEPS tender in `tendra` or on open-tender pages 1–15. `tendra`'s ARMEPS tenders
  were all published 10-12 → 10-21 and may simply not have failed yet. The ARMEPS path is the
  same code path as paper and is checked by the pure rules. The first real ARMEPS cancellation is
  a live check, like ticket 29's.
- **Half the notices are unreadable, and a quarter of those are e-auctions.** Of 180, 106 are not
  `.docx`/`.zip`. e-auction ones are skipped before the format is asked, so they never reach the
  count. The format-count query's `failed` kind shows what is left.
- **Rejection reasons and participants are read off the table, not stored.** A migration, if they
  should reach the API.
