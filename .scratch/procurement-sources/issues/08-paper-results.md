# 08 — Paper results: every bidder's price

**What to build:** A supplier sees every bidder's price on a finished paper tender. Competitor
prices, benchmarks and bid reconciliation work on paper tenders, compared on net price like
everything else. The paper tender becomes `awarded`. Spec: *Sources and parsers → gnumner*
(contract-concluded parser). Research: the two sampled 323-Ա notices.

**Blocked by:** 06, 15

**Status:** done

- [x] The «Կնքված պայմանագրի մասին հայտարարություն» listing is swept with watermark rules. Only
      notices for paper tenders are written. Notices for ARMEPS or e-auction tenders are skipped,
      because their results come from PPCM and eauction (ADR 0004 ownership).
- [x] A pure parser for template 323-Ա (`.docx`) yields, per lot: every bidder's name, net price,
      VAT and total, rejected bids with reasons, the winner, the contract price and the contract
      date.
- [x] Rows write `public_tender_bids` and `awards` with `source = 'gnumner'`: net into the `*_net`
      columns and total into the gross ones. A non-VAT payer's empty VAT cell means net equals
      gross.
- [x] The notice resolves through the resolution module. If it has no candidate or is ambiguous,
      it is an unmatched result. A later-appearing tender picks it up.
- [x] The tender's status becomes `awarded` through *derive status*, with the gnumner contract
      notice as the owning source.
- [x] Unreadable formats count as `unsupported_format`, with the same owner comment as ticket 06.
- [x] Verified by hand on `de685221.docx` and `ca55aac0.docx` (research.md): parsed figures equal
      the documents.
- [x] `competitor-prices` returns the paper tender's bidders, and a benchmark with too few
      comparables still says `insufficient_data`.

## Verification (2026-10-21/22, local Postgres `tendra`, MinIO, Redis `localhost:6379`, live gnumner)

No worker was running. Listing pages went through the production `readListingPage` with the
gnumner board; the jobs a page queued were run in-process through `processIngestFetch` and
removed; `ingest.normalize` was drained by a normalize-only worker (it held nothing else). Every
request went through the `gnumner` rate limiter, scripted fetches 3 s apart. Jobs a page queued
that were not part of a case were left queued, as tickets 04 and 07 did. No test runner: the pure
rules are 28 assertions in a scratch script.

**Pure rules (28 assertions).** A contract notice's code lookup is channel-free; one paper tender
with the same invitation day → `link` (a late-evening publication is the same Yerevan day); another
day, no invitation date, a lot the tender lacks → `no_candidate`; two runs → `ambiguous`; a code
held only on e-auction → `skip other_channel`, also for an unreadable file (asked before the
format); a code on ARMEPS and paper → the paper one; unreadable paper → `unsupported_format`; the
title's code wins, the body's is used when the title has none, neither → `no_code`; a result never
creates; amendment notices unchanged. `deriveStatus`: gnumner's `awarded` moves a paper tender from
`active`/`amended`/`closed`, never from `cancelled`; PPCM's word does not count for paper. The ledger
shape: net into `finalValue`, total into `finalPrice`, VAT 20, no rank, no initial offer, the award
explicit. The amount, date and name readers on every spelling below. Synthetic notices for the
review's fixes (an all-satisfactory evaluation row is not a rejection; the named winner wins; no
phantom bidder; no award → no `awarded`).

**Nothing else moved.** Checksums of every domain table, then `npm run normalize:replay` over all
1,229 stored payloads with the new code (the Word plumbing moved out of `invitation.parser.js`, the
resolution change, the normalizer hook): 1,222 unchanged + 5 unmatched + 2 superseded, **every
checksum identical** — tickets 06 and 07's numbers. Repeated after the review's fixes: identical.

### By hand: the parser against the documents

`de685221.docx` (ԽՄՄ-ԳՀԾՁԲ-26/09) and `ca55aac0.docx` (ՀՊՏՀ-ԳՀԱՊՁԲ-26/ՄՊԼ-1), read out of the
downloaded files:

| | document | parsed |
|---|---|---|
| de685221 | invitation 11.09.2026; lot 1, budget 4 900 000; «ԱՅԱՅ ՍԵՔ» ՍՊԸ 3 323 470 + 664 694 = 3 988 164; « ԷՄ ԷՍ կոմպ» ՍՊԸ 4 080 000 + 816 000 = 4 896 000; contract to ԱՅԱՅ ՍԵՔ, 15.10.2026, 3 988 164 | the same, winner matched, signed 2026-10-15 |
| ca55aac0 | invitation 18.09.2026; lot 1, budget 350 000; «Եթերակ» ՍՊԸ 280 000 + 56 000 = 336 000; ԱՁ Գառնիկ Սարոյան 348 000, **VAT cell empty**, 348 000; contract to Եթերակ, 16.10.2026 | the same; the ԱՁ net = total = 348 000, VAT 0 |

Neither can be linked: their invitations are not on the quotation listing — pages 36–37 cover
09-04 → 09-22 and hold neither code or buyer. The template asks for the date the invitation was
"sent **or** published", and these were sent (see *Most contract notices will never match*).

Then 31 live uploads from the listing's first ten pages (34 Word documents, with both samples):
**30 read, 3 refused** — a zip holding only PDFs; a lot range «1-47» priced as one; and ff878535
(below). Every reading was compared with the document's own rows while the parser was written;
the spellings it reads, all seen: VAT as `0`, `-` or blank; amounts `3323470`, `3 323 470`,
`6,480,000`, `2 505 766.43`, `289667,5/…in words…/`; dates `11.09.2026թ.`, `2026-09-11`,
`24․09․2026թ․`, `23. 09 2026թ`, `08.10.2026 թ.г.`; the lot as a «Չափաբաժին N» row, a numberless
one, a first cell under a «Չափաբաժին» header, or carried in the bid row; a bidder listed twice
(570 000 and 700 000 — the lower kept); a contract row for lots «1.2» and «1, 5»; a consortium in
the price table named by one member in the contract (the lot's one standing bid wins); Russian
glued onto every cell; a second layout with the subject column inside the price table (fea0e532).

**ff878535 is refused on purpose.** One bidder, 36 rows numbered 1–36 under «Հ/Հ», 36 lots in the
subject table: the row number looks exactly like the lot. A first version read it so — and 5 rows
then exceeded their lot's budget, and the contract for lots 1–36 is the budgets' sum (42 020), not
the rows' (45 700). The rows are not the lots; a price that cannot be placed is not read.

### The listing, swept like tickets 04 and 15

- **Cold start** (no watermark): 5 pages (`maxListingPages`), 6 notices a page, all uploads:
  35 `source_payloads` rows (5 pages + 30 notices), 30 `paper.contract` jobs, watermark = page 1's
  newest (2026-10-21T19:17:26Z). The 30, run: **11 `no_candidate`, 18 `unsupported_format`
  (10 .doc, 5 .pdf, 3 .rar — plus the PDF-only zip and ff878535), 1 `no_code`** (its «code» is
  `B6272274368`). None linked: `tendra`'s paper tenders were all published 10-12 → 10-19, too
  recent to have contracts.
- **Repeat sweep**: page 1, «reached the watermark», **0 rows, 0 jobs**.
- **Re-read from storage** (the retry path for all 30, notices rebuilt from their stored listing
  pages): the same decisions, every checksum identical.
- The format-count query in the owner comment runs and reports `doc 10, pdf 5, rar 3, docx 1, zip 1`.

### By hand: a contract notice that reaches its tender — ԳՀԱՊՁԲ-ՀՎԿԱԿ-2026-66

Finding one took a scan. Of the contract listing's first 130 pages (~780 notices, 10-07 → 10-21),
exactly **one** names a code on the quotation listing's paper notices (pages 1–42, 08-11 → 10-21):
ՀՀ ԱՆ «Հիվանդությունների վերահսկման և կանխարգելման ազգային կենտրոն» ՊՈԱԿ, invitation `ef70ae11.zip`
(published 09-04 16:54, quotation page 38), contract notice `765109bf.zip` (10-08, contract page
127). Run in the harder order — the result first:

| step | what happened |
|---|---|
| contract page 127 through the chain (from the watermark, which did not move) | 6 notices recorded; `765109bf` → **`no_candidate`** (no tender yet) |
| quotation page 38 through the chain; `ef70ae11` run, then normalize | tender `whqobfs6pwomv08dw6aljvul` created, `closed`, deadline 09-11 15:00; the normalizer logged «re-reading 1 unmatched contract notices» and queued `gnumner-contract-retry-51b5498dc28f…-whqobfs…` |
| the retry (no request) | **linked**: `awarded`, version 2, a `results` link `contract:51b5498dc28f25cb449cc721`, 4 bids, 2 awards; the unmatched row resolved to the tender |
| `paper.documents` | 7 files, 5 lots; lots 1 and 5 are the notice's «Ռետինե երկարաճիթ կոշիկ» and the nitrile gloves |

The notice against what was written (all equal):

| lot | budget | bidder | net | VAT | total | award |
|---|---|---|---|---|---|---|
| 1 | 805 800 | Ագաթոն ՍՊԸ | 671 500 | 134 300 | 805 800 | yes, 2026-10-07 |
| 1 | | Մեյդ թու Մեյք ՍՊԸ | 1 197 083 | 239 417 | 1 436 500 | |
| 5 | 2 425 500 | Ագաթոն ՍՊԸ | 1 856 250 | 371 250 | 2 227 500 | yes, 2026-10-07 |
| 5 | | Մեյդ թու Մեյք ՍՊԸ | 2 004 750 | 400 950 | 2 405 700 | |

The contract row «1, 5» at 3 033 300 is 805 800 + 2 227 500; «Ագաթոն» ՍՊԸ there is Ագաթոն ՍՊԸ in the
bids. `source = 'gnumner'` on all six rows, `vat_pct` 20, `rank` and `initial_offer_*` null.

- **`competitor-prices`** (the controller, `IntelligenceController.competitorPrices`): `status ok`,
  `settled`, both lots `awarded`; lot 1 winner Ագաթոն at 805 800 / net 671 500, the other bid 78.3%
  above on net; lot 5 winner at 2 227 500, discount 8.2% on gross against the budget, the other
  bid 8.0% above on net.
- **Benchmark**: the tender states no CPV, so `insufficient_data` («tender has no CPV code»). To see
  the paper awards counted, lots 1 and 5 were given 18830000 for one call and set back to NULL:
  `insufficient_data`, «fewer than 5 comparable awards», `sampleSize 4`, basis `cpv_family`.
- **Alerts**: `match-…-v1` and `match-…-v2` (`changedFields: ['status']`) → `skipped: status_awarded`.
  The benchmark job ran (0 categories: no CPV).
- **Idempotent**: every notice re-run from storage → the same decisions, no version, no job, every
  checksum identical; `normalize:replay` → the invitation unchanged, the tender still `awarded` v2.
- **Two notices of one tender both stand**: a throwaway lot-2 ledger through `recordResults` → lots 1
  and 5 untouched, lot 2 added, no event; a call with a stale `expectedStatus` threw «… is awarded,
  not closed as resolved — re-resolve». The throwaway rows were deleted; checksums back to identical.

## Decided while building

- **Rule 3 compares the notice's invitation date**, «Հրավեր ուղարկելու կամ հրապարակելու
  ամսաթիվը», with the tender's `published_at` day. The notice's own publication is weeks later.
- **The notice names no channel** (`channelUnstated`): its code is looked up in every channel, and
  one Tendra holds only on e-auction or ARMEPS is skipped before the format is asked — ticket 07's
  lesson, so an e-auction's `.doc` is never an unreadable paper result.
- **The award is the one the contract names**, at the winning bid's net and total — not the
  contract's price (a framework sum, or the available funds only, in several notices) and never
  row order. The named bidder wins whatever the evaluation table says of it; only a name the bids
  do not carry falls back to the lot's one standing bid, else no award.
- **The evaluation table is not a rejection list.** Its header is «Գնահատման արդյունքները (բավարար
  կամ անբավարար)»; a row is a rejection only when a criterion is not «բավարար», and its reasons are
  the criteria that failed (seen: «Գնային առաջարկ: Գնման գնից բարձր գնային առաջարկ»).
- **`awarded` only with an award.** A notice whose winner names no bid on any lot writes its bids
  and leaves the status to the deadline.
- **No rank, no initial offer.** A sealed bid list is not a ranking, and one listed price is not
  known to be an opening one; a bidder listed twice keeps its lower (negotiated) price.
- **Paper suppliers are keyed by name** (`gnumner:bo:name:{sha of the key}`), quotes and `<<>>`
  ignored: the price table names bidders and nothing else.
- **A notice is keyed by its upload path** (`contract:{digest}`), like an invitation's notice,
  so an unmatched one can be re-read from its stored listing page. A byte-identical re-upload is
  two notices writing the same rows.
- **`replaceLedger` is lot-scoped for this source**, so notices covering different lots of one
  tender both stand; a corrected notice for the same lots replaces them.
- **A later-appearing tender picks it up**: the normalizer's `created` hook re-reads every
  `no_candidate`/`ambiguous` `contract:` row of the new paper tender's code, from storage.
- **No migration.** Nothing new in the schema, so ticket 30 gains no step.
- Fixed on the way: `observePaperNotice` referenced an undeclared `bodyCode` (from 20c4442), which
  threw for every paper notice whose title has no code.

## Review (`/code-review`, standards and spec)

Fixed from it (the checks, the corpus, the stored notices and the replay re-run after — identical):
- The evaluation table read as a rejection list, and a named winner the table listed lost its
  award to the other bidder; a name only the table carried became a phantom bidder.
- `awarded` was set with no award written.
- The move to `word.js` had turned the `﻿` escape into a literal BOM character.
- An orphaned doc comment; the one-lot fallback computed twice; the `contract:`/`paper:` id scheme
  split across two files (now `observation.js`); `procedureTypeOf` read `kind` differently from
  the board.

Left, on purpose:
- **`recordContract` repeats the normalizer's tail** (unmatched record, `markResolved`, match and
  benchmark jobs) — the third copy after `recordAmendment`. Folding them is a refactor of the
  existing idiom, as ticket 06 said of the rate-limit catch.
- **The armeps-link guard on the contract listing** covers a case not seen; one line, and without
  it an ARMEPS link there would re-read the armeps.am page.

## For the owner

- **Most contract notices will never match, and they are counted as if Tendra missed them.** The
  template asks for the date the invitation was "sent or published": most quotations are sent to
  invited suppliers and never reach gnumner. ~780 notices held one code from the published
  quotation listing. Every other one is `no_candidate` or `unsupported_format` — ADR 0004's "Tendra
  missed a tender", which the operator alert will read — and single-source procedures (a `ՄԱ`
  method marker) are 12 of the 18 `unsupported_format` and 4 of the 12 `no_candidate` here. Before
  the operator alert reads these, decide whether a result whose tender was never published is a
  miss; and before choosing a converter by the format count, leave single-source rows out of it.
- **"Notices for ARMEPS or e-auction tenders are skipped" holds only for codes Tendra holds**, the
  same rule as amendment notices; an e-auction code it does not hold is `no_candidate`.
- **Bid reconciliation works only for an organization whose claimed party is its paper party.**
  `organizations.supplier_party_id` is one party, and a company's paper party (keyed by name) is
  not its e-auction party (keyed by operator id). The notice carries the winner's ՀՎՀՀ in its
  address table — not the losers' — and nothing writes a supplier's ՀՎՀՀ yet (CLAUDE.md, an open
  decision). This is ticket 19's question for suppliers.
- **Rejection reasons are read, not stored** — `public_tender_bids` has no column. A migration if
  they should reach the API.
- ~~**A re-posted paper tender (ticket 07) may not take its result**~~ — resolved by the
  follow-up below.
- **A contract row typed «1» for six lots** (e906f6, priced at their sum) awards lot 1 only; read
  literally rather than guessed.
- `prospects.repo.js` counts wins as `rank = 1`; paper bids have no rank, so it counts them as
  neither — it predates this and breaks the awards rule anyway.
- The 9 other invitations on quotation page 38 and the 5 other notices on contract page 127 are
  recorded and their jobs left queued; `sweep:published:gnumner:contract` is set (2026-10-21T19:17:26Z).

## Follow-up: a re-posted run matches on any of its files (decided 2026-10-23)

**Decision.** A contract notice matches a re-posted paper tender (ticket 07) by the publish date
of **any** of its invitation files, not only the newest one, which is all `tenders.published_at`
holds.

**Where the dates come from.** The decision assumed the superseded links carry their file's
publish date; they do not. `tender_sources` has no such column, and a link's `first_seen_at` is
when Tendra ingested the file (ԵՊՊՔ's superseded `4c63e8ac…`: 10-21 17:37, not 10-08 18:12).
A file's publication exists in one place, the listing page its notice was stored with, which
is where its deadline was already counted from. So no column was added:
`paperNotice.service.js#runPublications` reads each file link's earliest notice back from
storage (the `observeInvitation` rule), and `withRunPublications` attaches them to a contract
notice's candidates as `runPublishedAt` — **only** for a paper candidate that holds a superseded
run, so an ordinary tender costs no read. `resolution.service.js#datesAgree` stays pure: the
notice's day agrees with any of the run's days. A column would be the alternative if
these reads ever matter (a migration, a backfill from the same pages, a ticket 30 step).

**Also, so the rule can fire.** A notice dated by a re-post's file and read before that file
joined matched nothing, and the re-read hook fired only when a tender was created. The
normalizer's hook (now `newFile`) also fires on a re-post join, and the retry job's id carries
the tender's version, since BullMQ keeps a finished job's id.

**Verified (2026-10-23, local `tendra`).** On ԵՊՊՔ-ԳՀԱՊՁԲ-26-3 as `tendra` holds it, the real
candidate from `findCandidates` enriched from its two files' stored notices, `node:assert` on
`resolve()` with throwaway contract notices (nothing written, 10 checks):

| | |
|---|---|
| the stored run | `a6an3qgjtwm5g2gmurv9pehx`, `replaced_runs`, `published_at` 10-12 12:19:45 (the newest file), lots 1–4 |
| `runPublishedAt` | 10-08 18:12:43 (`7206883e`) and 10-12 12:19:45 (`2935628f`; its byte-identical 12:40 re-upload is a later notice of the same file) |
| invitation dated 10-08, **before** | `no_candidate` |
| invitation dated 10-08, **now** | `link`, rule `code` |
| dated 10-12 | `link`, before and now |
| dated 10-10 (no file) | `no_candidate` |
| lot 9 | `no_candidate` |
| a same-code re-announced run also published 10-08 | `ambiguous`, both named |
| a single-file paper run, an e-auction | not enriched |
| `runPublications` | 2 dates — the 3 notice links and the amendment notice are not files |

The 28 pure checks still pass. The 31 stored contract notices re-read: the same decisions,
every checksum identical. `normalize:replay`: 1,222 unchanged and **one `TenderAmended`** —
ԵՊՊՔ itself, `amended` v3 → `closed` v4, because its deadline (10-22 12:00) passed since the
last replay. That is the paper close-out `refresh-gnumner` performs (no scheduler runs locally),
seen live here for the first time; its match job → `skipped: status_closed`. The checks re-run
on the closed run pass, and a second replay is identical. The join path of the hook was not
exercised live: no re-post arrived, and ticket 07's way to make one deletes a tender.
