# 06 — Paper tenders appear in Discovery

**What to build:** A supplier sees paper quotations (and the rare paper open tender) in the tender
list, labelled `paper`, with buyer, subject, delivery address and a real deadline date and time, so
they never have to open a Word file and count days. A paper tender appears even when its procedure
code cannot be read. Spec: *Sources and parsers → gnumner* (paper invitation parser, unsupported
formats).

**Blocked by:** 03, 04

**Status:** done

- [x] A pure paper-invitation parser reads `.docx` and `.docx` inside `.zip`. It yields procedure
      code, buyer, subject, delivery address, deadline and lots where present.
- [x] **Before anything else, the deadline rule is checked on real cases:** "N-th day counted from
      publication, at HH:MM". Does the count include the publication day, and are the days
      calendar or working days? Record the evidence here. The deadline is computed from the
      gnumner publish datetime.
- [x] `submission_channel = 'paper'`. The tender's links are the gnumner invitation URL, with
      roles `discovery` and `detail`.
- [x] No readable code still creates the tender (title, buyer, dates), and also records `no_code`
      in unmatched results so it is counted.
- [x] Any other format (`.doc`, `.rar`, `.pdf`, scans) is recorded as `unsupported_format` and
      counted. **The format check carries a comment addressed to the owner** saying these formats
      are counted on purpose and meant to become supported once the counts show which ones
      matter.
- [x] The invitation file is stored and listed in `tender_documents`.
- [x] Raw files are kept, replay works, and a repeat sweep writes nothing.
- [x] Verified by hand on five live paper quotations: parsed deadline vs the document text. Record
      them here.
- [x] `GET /tenders?submissionChannel=paper` returns them, and keyword saved searches alert on
      them.

## The deadline rule, checked first (2026-10-21)

Before the calculation was written. Live gnumner quotation notices, published 2026-02-03 →
2026-10-20: 12 listing pages fetched with their uploads (56 paper notices), 63 more listing pages
without (497), and the uploads of 9 chosen cases. Every request went through the `gnumner` rate
limiter.

The invitation states «… հրապարակման օրվանից հաշված N-րդ օրվա ժամը HH:MM» ("the N-th day
counted from publication, at HH:MM"). The buyer also types a close datetime into the gnumner
listing when posting, which records how *they* counted, independently of the document:

| Check | Result |
|---|---|
| notices with both the document's N and a listing close | 36 |
| listing close = **publication date + N calendar days** | **34 of 36** (N = 7, 8, 10, 14 all fit) |
| the 2 disagreements | both: document "8th day", listing +7 (e30a9d3b.docx, f5d14d1f.zip) |
| publication day counted as day 1 (publication + N − 1) | 0 of 36 |
| working days | 0 of 36: all 6 Friday notices close the next Friday, all 15 Tuesday ones the next Tuesday — counting the publication day would give Thursday and Monday, working days both, so no weekend rollover can explain it |
| time | the document's HH:MM matches the listing's in 35 of 36 (ԳԱԱ-ԳՀԽԾՁԲ-26/27: 11:00 vs 12:00) |

Three invitations confirm it from inside the document. be386291 says «հրապարակման **հաջորդող**
օրվանից հաշված 8-րդ օրվա ժամը 14:00» ("8th day counted from the day *following* publication")
and gives its bid opening as «հոկտեմբերի 23»: published 10-15, so 10-15 + 8. The open tender
ԵՔՆԱ-ԲՄԾՁԲ-27/01 says «… հաջորդ օրվանից հաշված 41-րդ օրվա ժամը 9:00» and opens «նոյեմբերի 29»:
10-19 + 41. A Russian copy (ԵԷՊԱ-ԳՀԱՇՁԲ-26/38) says «до 09:30 часов 7-го дня со дня
опубликования» and opens «27 октября»: 10-20 + 7. Whether the text says "from publication" or
"from the day after", the count starts the day after.

**Rule: deadline = Yerevan calendar date of publication + N days, at the document's HH:MM
(UTC+4).** Two invitations state a date instead («մինչև 27.10.2026թ օրվա ժամը 12:30», also
«26,10,2026»), which is taken as it is.

**Holidays (decided 2026-10-21: literal date).** Publication on a weekend is practically
nonexistent (1 Saturday in 553). Holidays do occur, and buyers handle them inconsistently: two
wrote "8th day" exactly when day 7 was a holiday (ԲՀՍ-ԳՀԾՁԲ-26/26, Sep 21; ԻԿՎԾԻԿ-ԳՀԱՊՁԲ-26/34,
May 28), two left day 7 on one (ԳՀԱՇՁԲ-ՀՎԿԱԿ-2026-40, May 28; ԻԿՎԾԻԿ-ԳՀԱՊՁԲ-26/29, Apr 24 — the
same buyer as the May adjustment). The Civil Code's article on a period ending on a non-working
day (Art. 329, by its title) could not be read in full. The deadline is never rolled forward:
the worst case is a supplier told a day early, while a maintained holiday calendar that is wrong
tells them a day late and loses the bid. One document (ՇԲՕ-ԳՀԱՊՁԲ-26/26) puts its 8th day on a
Saturday; it is shown as the Saturday.

## Verification (2026-10-21, local Postgres `tendra`, MinIO, Redis `localhost:6379`)

No full worker was run: `ingest.fetch` still holds the e-auction backlog. The 22 `paper.invitation`
jobs ticket 04 parked were run one by one through the production `handlePaperInvitation` (rate
limiter included, 3 s apart), then removed from the queue. `ingest.normalize` was drained by a
normalize-only worker, and the `paper.documents` jobs were run by hand and removed.

**e-auction and ARMEPS unchanged first.** Canonical checksums of `tenders`, `tender_lots`,
`tender_documents`, `awards`, `public_tender_bids`, `parties`, `unmatched_results`, `tender_sources`,
then `npm run normalize:replay`: 1,206 unchanged, every domain table identical. `tender_sources`
gained 113 rows: e-auction `superseded` predecessor links that ticket 29's `saveNormalized` writes
for every page naming a replaced run, on this database's first replay since it landed — not this
ticket's change.

**Ingestion.** 22 notices → 19 distinct files (3 were byte-identical re-uploads).

| | |
|---|---|
| tenders created | 14: 13 `quotation`, 1 `open` (ԵՔՆԱ-ԲՄԾՁԲ-27/01), all `submission_channel = 'paper'`, `active` |
| deadline / address / subject | 14 / 14 / 14 |
| procedure code | 12; 2 Meghri invitations carry none, in the file or the title → created and recorded `no_code` |
| `unsupported_format` | 5: one `.rar`, two `.7z`, two `.zip` whose Armenian invitation is itself a `.rar` (only the RU/EN copies are `.docx`) |
| links | 14 `detail` (the file) + 17 `discovery` (one per readable notice); 3 tenders have 2 notices |
| documents | 14 stored and listed (`.zip` as is; `.docx` wrapped in a one-entry ZIP), 80 lots |
| raw payloads | 19 under `raw/gnumner/detail:{sha256}/…`, extension from the sniffed format |

The count query in the format-check comment works and reports `rar, 7z, 7z, zip, zip`.

Two normalize jobs retried once: a re-upload's re-normalize ran alongside the first upload's
normalize, and the unique `tenders.source_id` rejected the second create; the retry linked it.
The second notice's re-normalize is now delayed a minute, so the race is rare rather than routine.

**Repeat and replay.** The 22 jobs rebuilt from the stored listing pages by the board's own
`toNotice` and run again: 22 `unchanged`, 0 files stored, every normalize unchanged, all checksums
identical. `npm run normalize:replay` over all 1,225 stored payloads (paper included — read back
through their notice links, with no job notice): 1,220 unchanged + 5 unmatched, identical again.
The same after the parser learnt «հաջորդ օրվանից» (see the open tender below).

### By hand: five live paper quotations, document vs stored

Read straight out of the stored raw file. Times are Yerevan.

| Tender | Document says | Published | Stored deadline | Listing close |
|---|---|---|---|---|
| ԿԲՀ-ՍԱՊ–ԳՀԱՊՁԲ-26/19, «Սևան» ազգային պարկ (`.docx`, 2 uploads) | «… հրապարակման օրվանից հաշված 7-րդ օրվա ժամը 12:00-ն» | Mon 10-19 17:10 (the earlier upload) | Mon 10-26 12:00 | Mon 10-26 12:00 |
| ԳՄԵԲԱ-ԳՀԱՊՁԲ-26/2, Երանոսի ԲԱ (`.docx`) | «… 8-րդ օրվա ժամը 16:00-ը» | Mon 10-19 15:22 | Tue 10-27 16:00 | Tue 10-27 16:00 |
| ՍԲԿՏ-ԳՀԱՊՁԲ-2026/7, Սիսիանի ԲԿՏ (`.zip`, 2 uploads) | «… 8-րդ օրվա ժամը 11։00-ը» (Armenian colon) | Mon 10-19 16:55 | Tue 10-27 11:00 | Tue 10-27 11:00 |
| ԵՏՀՈՒԱԽՄ-ՊՈԱԿ-ԳՀԱՊՁԲ-26/02 (`.docx`) | «… մինչև 27.10.2026թ օրվա ժամը 12:30-ը» (a date) | Mon 10-19 15:53 | Tue 10-27 12:30 | none on the listing |
| ՏԷՀԿԿ-ԳՀԱՊՁԲ-26/15 (`.docx`) | «… 7-րդ օրվա ժամը 16:30-ը» | Mon 10-19 16:45 | Mon 10-26 16:30 | Mon 10-26 16:30 |

Address, subject and buyer in all five are the document's own text, e.g. «Գեղարքունիքի մարզ, ք.
Սևան, Կարմիր բանակի 56» / «Վարչական սարքավորումների» / «Սևան ազգային պարկ ՊՈԱԿ», with 4 lots.
The open tender: «… հրապարակման հաջորդ օրվանից հաշված 41-րդ օրվա ժամը 9:00» → Sun 11-29 09:00,
which is also its stated bid-opening date. That spelling was the one the parser first missed; the
listing's close (the same) was used and logged, and then the parser was taught it.

Offline, the parser over every upload downloaded for the evidence (54 files): 51 readable; of
those 51 deadline, 51 address, 51 buyer, 43 subject, 46 code, 48 with lots.

**API and alerts.** `filter[submissionChannel]=paper` through `tenderQuerySchema` and
`TenderService.search`: 14 tenders, all `paper`, all with `submissionAddress` and `deadlineAt`;
`paper,armeps` returns 68. The detail of ԿԲՀ-ՍԱՊ–ԳՀԱՊՁԲ-26/19 shows `description`,
`submissionAddress`, 4 lots, one `stored` invitation document and links `discovery 05942746.docx`,
`discovery be16084d.docx`, `detail be16084d.docx`; its file streamed out of the stored archive
at the manifest's size (247,859 bytes). A throwaway user, organization and saved search with the
single keyword `սարքավորում` (no CPV), `handleTenderMatched` on that tender: 1 match, 1
`tender-match` notification, delivered to the dev log channel; all three deleted afterwards.

**Close-out refresh.** No stored paper deadline has passed yet (the first is 10-26 11:00), so
the transition itself was not seen live. Checked in pieces: `deriveStatus` for paper gives
`closed` past the deadline; the refresher's query as of 2026-10-27 09:00Z (read-only) picks 12 of
the 14; `paperRefresher.find` today picks 0; one refresh job end to end re-normalized from
storage with no request and wrote nothing. `npm run scheduler` was not run, so `refresh-gnumner`
is not registered in Redis yet.

### Decided while building

- **The detail link's id is the file's content hash** (ADR 0004, *Paper invitations*). Each
  notice is a `discovery` link `paper:{digest of its path}` whose URL is the upload it points at —
  the ticket's "the gnumner invitation URL, with roles discovery and detail", one row per role.
- **Readable means the Armenian template was found**, not merely "a .docx". A zip whose only
  `.docx` is the Russian or English copy (its Armenian invitation is inside a `.rar`) is
  `unsupported_format`: the invitation is in a format we do not read.
- **The listing's typed close is the fallback** when the invitation's sentence is not found, and
  a disagreement is logged with the document's figure winning.
- **`tenders.submission_address`** (text, nullable) added with the four-step workflow: script
  run twice on `tendra`, mirrored into `create_table.js`, deleted in the next commit
  (`git show b5cd180:migrations/add_submission_address.js`). Neon is not touched; whoever
  migrates it runs that script with the earlier tickets'.
- **`tenders.description` carries the paper subject.** SCRAPER_WORKFLOW's "no source, never
  written" was about e-auction, whose subject line is its title; a paper notice's title is a
  long headline and the subject is not a copy of it. Reversible: drop it from `observation.js`.
- **Title is the notice headline**, the procedure type the listing's (`procedureType` on each
  `listingPaths` entry), CPV codes and lots from the invitation's lot table where it has them.
- A re-issued invitation with different bytes is a second tender until ticket 07 joins
  amendments (ԵՊՊՔ-ԳՀԱՊՁԲ-26-3: 10-08 with "14th day" and 10-12 with "10th day", one deadline).
- `unmatched_results.procedure_code` keeps a known code when a re-read knows none (a replayed
  unreadable upload has no notice with it).

### Review (`/code-review`, standards and spec)

Fixed from it, and replayed again afterwards (1,225 payloads, every checksum identical):
- **Keyword alerts read the subject.** The matcher's haystack was title, code and lot names; a
  paper tender's lots arrive with its document stage, after the ingest match, so its subject
  (`description`) is now in it. A keyword found only in the subject matches.
- **A stated date must exist**: «31.09.2026» was read as 1 October; it is now refused (and the
  listing's close used), checked on constructed invitations for 31.09, 30.09, 29.02 and 26,10.
- **A paper tender stored with no deadline at all is said**, not silent. The adapter returns its
  `warnings` and the normalizer logs them, so the generic normalizer no longer knows what a
  paper deadline is.
- The upload-path check moved before the fetch (no retry semantics read off an error message);
  one helper for the paper notice ref; the refresh's hour bucket travels in its job.

Left, on purpose:
- **`no_code` applies to every detail source**, not only paper: any tender created with no code
  can never take a result by rule 3, whichever site created it. None exist today (replay wrote
  none for e-auction or ARMEPS).
- **A `.docx` without the Armenian template counts as `unsupported_format`**, as decided above;
  the reason list is fixed by a CHECK, and "the invitation is in a form we do not read" is what
  the count is for.
- **The close-out refresh is beyond the checklist**, and kept: without it a paper tender stays
  `active` for ever, because its file never changes.
- A readable file whose first save was skipped for `no_buyer` has no notice links, so its replay
  fails visibly rather than skipping. None of the 51 readable files lacked a buyer.
- The rate-limit catch and the re-normalize shape now exist in four and two workers; folding
  them is a refactor of the existing idiom, not this ticket's.
