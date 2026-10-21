# 07 — Paper deadline changes reach the supplier

**What to build:** When a buyer moves a paper tender's deadline, the supplier sees the new deadline
and gets an alert about the change. For paper this is the only place a change is published.
Spec: *Sources and parsers → gnumner* (amendment listing). User stories 6–7.

**Blocked by:** 06, 15, 18

**Status:** done

- [x] **A changed invitation re-posted on the invitation listing is also an amendment** (decided
      2026-10-21, found in ticket 06). Example: `ԵՊՊՔ-ԳՀԱՊՁԲ-26-3` was uploaded on 10-08 and again,
      changed, on 10-12 with the same deadline, and today it is two tenders.
      - Paper has no predecessor pointer, so the rule is: a new paper invitation with the same
        normalized procedure code and the same buyer as a paper tender that is **still open**
        (alertable status, deadline ahead) joins it. Its document set change is an addendum
        (ticket 18), and a moved deadline is a field amendment.
      - Once that tender has closed or been cancelled, the same code is a new run
        (a re-announcement, ADR 0004).
      - No readable code → no join, as today.
      - Fold the existing local pair, and record how.
- [x] The «Հրավերում կատարված փոփոխություններ» listing is swept with the same watermark rules as
      ticket 04.
- [x] An amendment is resolved to its paper tender through the resolution module (procedure code +
      paper channel + dates). If it can't be resolved, it is an unmatched result, never a guess.
- [x] A changed deadline raises a new `version`, sets `amended` and re-notifies through the
      existing amendment path with a change summary. `notifications_dedupe_uq` prevents
      duplicates.
- [x] An amendment notice that moves no stored field is still an addendum (decided 2026-10-20,
      ticket 18). It raises a new version and notifies with a change summary that names the
      document, not a field, and only while the tender is open.
- [x] Unreadable amendment files count as `unsupported_format`.
- [x] Verified by hand on two real amendments. Record them here.

## Verification (2026-10-21, local Postgres `tendra`, MinIO, Redis `localhost:6379`, live gnumner)

No worker was running. Listing pages were read one at a time through the production
`readListingPage` with the gnumner board, and the jobs it queued were run through
`processIngestFetch`, `ingest.normalize` drained by a normalize-only worker, the matcher run by
hand. Every request went through the `gnumner` rate limiter, and scripted fetches were 3 s apart.
Jobs a page queued that were not part of a case (other notices, ARMEPS re-reads) were left
queued, as ticket 04 did: their notices are recorded, so they must not be lost.

**Pure rules first.** `resolve`/`lookupsFor` checked with 30 assertions in a scratch script (no
test runner): newer re-post joins; older file read late is `superseded`; a run closed, cancelled
or awarded before the re-post → new run; other buyer, channel or code → new run; no buyer or the
same second → no join; two runs → `create` + `ambiguous`; rule 1 still first; amendment notice
matched only while open, status not read, never creates; e-auction/ARMEPS code → `skip`, also
for an unreadable file; rule 3 for results unchanged.

**Nothing else moved.** Checksums of every domain table, then `npm run normalize:replay` over
1,225 stored payloads after the change (and the migration): 1,220 unchanged + 5 unmatched, every
checksum identical — the 14 existing paper tenders read their notices through `points_to` now.
The 11 stored gnumner listing pages parse byte-identically with the new date selector.

### The amendment listing, swept like ticket 04

`hraverum_katarvats_popokhutyunner` (6 notices a page, 729 pages). Its date paragraph has no
`tender_time` class, so the old parser read **0 of 6** blocks on every page (`noDate`); it now
reads 5–6 (the rest are duplicates).

- Cold start, no watermark: 5 pages (`maxListingPages`), 31 `source_payloads` rows (5 pages + 26
  notices), 26 jobs (17 `paper.amendment`, 9 `armeps.detail`), watermark = page 1's newest.
  Page 1 vs its stored HTML: 6 blocks, 4 uploads + 2 ARMEPS links; the sweep said 4 paper, 2
  armeps.
- Repeat: stopped on page 1 ("reached the watermark"), **0 rows, 0 jobs**.
- An ARMEPS item whose window equals the one already recorded from the quotation listing has
  the same fingerprint and is not re-queued (1 of 21 on 14 pages); the hourly ARMEPS refresh
  covers it.

The `paper.amendment` jobs of the cold start (re-run after the refinement below, on a fresh
copy of the same rows): **16 notices → 10 `other_channel`** (codes held on e-auction or ARMEPS),
**3 `no_candidate`**, **3 `unsupported_format`** (`.doc`). The first run, with the format checked
first, gave 10 `unsupported_format` — 5 of those 7 distinct codes were tenders Tendra holds on
e-auction or ARMEPS, which would have buried the paper formats the count exists for. So the
channel is asked first. Three byte-identical uploads of one notice are one unmatched row.

What 14 pages of the listing hold: 81 items — 21 ARMEPS links, 60 uploads (32 `.doc`, 16 `.docx`,
6 `.rar`, 4 `.pdf`, 2 `.zip`). Nearly every `.docx` is the Article 29 template (code, reasons in
prose, buyer); none states a new deadline in a form worth reading — one says «… 05.10.2026թ
ժամը 14:30-ի փոխարեն 06.10.2026թ ժամը 14:30» in a sentence. Dates are therefore never read out
of a notice: a moved paper deadline arrives through the re-posted invitation.

### How often a code is re-posted

On the quotation listing's first 40 pages (371 notices, 08-14 → 10-21; 135 paper), 14 codes have
two or more uploaded files. Downloaded and hashed: most are byte-identical re-uploads minutes
apart (already one tender, ticket 06). Two are real re-posts with different bytes, below.

### By hand: two real amendments

**1. ԵՊՊՔ-ԳՀԱՊՁԲ-26-3 — open, so it alerts.** «Երևանի պարարվեստի պետական քոլեջ» ՊՈԱԿ. Three
uploads on the quotation listing: `7206883e.zip` (10-08 18:12, «14-րդ օրվա ժամը 12:00»),
`2935628f.zip` (10-12 12:19, «10-րդ օրվա») and `4ec967d6.zip` (10-12 12:40). **The last two are
byte-identical**, so this is one re-post, not two. Plus the Article 29 notice `e66bc759.docx`
(10-12 12:46) on the amendment listing. Run in publication order, the live path:

| step | version / status | deadline | what was written |
|---|---|---|---|
| `7206883e` | 1 / `active` | 10-22 12:00 (10-08 + 14) | tender, invitation set (2 files), 4 lots, `match-…-v1` |
| `2935628f` joins | **2 / `amended`** | 10-22 12:00 (10-12 + 10) | `7206883e` link `superseded`; one alert `match-…-v2`: fields `title, status, published_at, invitation_url`; files replaced `Apranq_txtayin 2026 - 3.docx`, `Ռուսերեն հրավեր -26-3.docx`, added `հրավերում փոփոխություն հայերեն.docx`, `… ռուսերեն.docx` |
| `4ec967d6` (same bytes) | 2 / `amended` | — | one more notice link, pointing at `2935628f`'s file; normalize unchanged |
| notice `e66bc759` | **3 / `amended`** | — | a `tender_documents` row of kind `amendment`, link `amendment:940ccfb6…` (`discovery`); one alert `match-…-v3`, no field, `added: ["e66bc759.docx"]` |
| notice again (`recordAmendment` re-run) | 3 | — | nothing; the v3 alert re-queued under its own id |

The matcher, with a throwaway user, organization and saved search on `վահանակ`: v1 → 1
`tender-match`; v2 → 1 `amendment` (subject `v2`), change line «title, status, published_at,
invitation_url, new document: հրավերում փոփոխություն հայերեն.docx, … replaced document:
Apranq_txtayin 2026 - 3.docx, …»; v3 → 1 `amendment` (subject `v3`) «new document:
e66bc759.docx». Every job run a second time: 0 notified (`notifications_dedupe_uq`). The
throwaway rows were deleted.

**2. ՇՄԱՀԿՍ-ԳՀ-ԱՊՁԲ-26/23 — the deadline moved, and it has closed.** ՀՀ Շիրակի մարզի «ԱՇՈՑՔ
ՀԱՄԱՅՆՔԻ ԿՈՄՈՒՆԱԼ ՍՊԱՍԱՐԿՈՒՄ» ՀՈԱԿ. `27fb50e4.zip` (10-13 14:57) and `2c1a012b.zip` (10-14
11:38), both «7-րդ օրվա ժամը 11:00», 3 files each with different CRCs: the re-post moved the
deadline from 10-20 11:00 to **10-21 11:00**, which has passed. Run both ways:

- **Newest first** (a cold start's order): `2c1a012b` created the tender, v1 `closed`, deadline
  10-21 11:00; `27fb50e4` → `superseded` link, its notice still linked and pointing at it, no
  version, no alert.
- **Publication order** (the tender and its two file payloads deleted, the same notices run
  again): v1 deadline 10-20 11:00 → **v2, `deadline_at` moved** (`title, published_at,
  deadline_at, invitation_url`, 3 files replaced), status `closed`. The matcher skipped v1 and v2
  as `status_closed`: past the deadline, version only.
- Both orders end the same: deadline 10-21 11:00, `2c1a012b` the current file, the same four
  links and pointers. Only the version differs (1 vs 2).

**The race guard.** `saveNormalized` called for ԵՊՊՔ with `supersedeCurrent` and a file
published 10-08, older than the tender's 10-12: threw «now holds a newer file … re-resolve» and
wrote nothing (still v3, one current file).

**Refresh.** `findPaperPastDeadline` reads one current file per tender: `ce1e8c15…` for ԵՊՊՔ,
`b4fe5543…` for ՇՄԱՀԿՍ; superseded files and `amendment:` links are left out.

**Replay afterwards.** `normalize:replay` over 1,229 payloads: 1,222 unchanged + 5 unmatched + 2
superseded (the two replaced files, which write only their link); every checksum identical; no
alert queued.

### Folding the local ԵՊՊՔ-ԳՀԱՊՁԲ-26-3 pair

It was **never two tenders in `tendra`**. Ticket 06 saw the pair in its evidence downloads
(`items.json` of that session's scratch), not in the database: all 14 paper tenders there were
published on 10-19. So there was nothing to merge. It was folded by ingesting all three uploads
through the new rule, above: one tender `a6an3qgjtwm5g2gmurv9pehx`, both files and all three
notices on it.

### Decided while building

- **Dates decide, never the stored status or the order of arrival.** Two files join when the
  earlier was still open as the later was published; the newer is the tender. A cold start
  reads newest first, so arrival order would otherwise make the oldest file current.
- **`tender_sources.points_to`** (migration below): a notice link records which link it is a
  notice of. With several files on one tender, the old "every `paper:` link of the tender" read
  would count a re-post's deadline from the first file's notice.
- **A tender's `published_at` is its newest file's**, as for an e-auction replacement (ticket
  29). It is what the row-lock guard reads.
- **An amendment notice is a `discovery` link and a document of kind `amendment`.** Not `detail`
  — a re-post supersedes every other current detail link — and not an invitation set, which
  `findPreviousDocument` now compares only within its own kind (ARMEPS `contract_documents`
  included). The checklist reads `kind = 'invitation'` only, so a notice never becomes "the
  invitation".
- **The change summary of a notice is the file's upload name** (`e66bc759.docx`): that is what
  gnumner calls it.
- The sibling listing «Հրավերներում կատարված փոփոխություններ» (public organizations, outside the
  procurement law) is not read.
- `tenders.procedureType` stays the listing's; the amendment listing names none.

### Review (`/code-review`, standards and spec)

Fixed from it (the checks above re-run after; the ՇՄԱՀԿՍ race below is from the fixed code):
- **Two files of one code normalized at once became two tenders for good.** Both found no run and
  created; rule 1 then kept them apart on every replay. A paper create now takes an advisory
  lock on its code and throws if a same-code tender appeared that resolution did not see; the
  retry resolves against it. **Checked live**: ՇՄԱՀԿՍ deleted again and both files' normalize
  jobs queued together on a 4-way worker — `27fb50e4` created, `2c1a012b` threw «… created
  meanwhile — re-resolve» on attempt 1 and joined on attempt 2: one tender, v2, the same final
  state as both orders above. (Its join alert went out without the file list: the deleted
  tender's document job id was still held by BullMQ as completed — an artifact of deleting a
  tender, which production never does — and that is the designed fallback.) Replay afterwards:
  1,222 unchanged + 5 unmatched + 2 superseded, identical.
- **A run with no deadline counted as open for ever**, so a re-announcement months later would
  have joined it. It now joins nothing (and a notice cannot attach to it): a missed join is a
  visible second tender, a wrong one a silent merge.
- **A notice published between two files and read after the re-post found nothing**: the tender
  carries its newest file's `published_at`. For a tender holding a superseded run that bound is
  no longer asked.
- One `queueAmendment` for the three amendment-alert enqueues; one `sameProcedure` check;
  `runs` renamed `codeRuns`; `markResolved` skipped for a rule-1 link; the migration's blank
  count ignores `amendment:` links.

Not changed, for the owner:
- **`other_channel` writes no row.** A notice whose code Tendra holds only on e-auction/ARMEPS
  is logged and skipped, not an unmatched result — it is resolved, just not ours to attach, and
  the reason list is a CHECK. If a paper tender was missed *and* its code exists on another
  channel, nothing counts it. Recording it needs a new reason (a migration).
- **No live case of a moved deadline that alerts.** ԵՊՊՔ alerts but kept its deadline;
  ՇՄԱՀԿՍ moved its deadline but had closed. The alert is the one `TenderAmended` path both share
  (`raiseJoin` → matcher), which ԵՊՊՔ exercised end to end.
- A notice retried after its commit re-queues under the tender's current version, as ticket
  18's `recordDocuments` does.

### Left, on purpose

- **An unreadable notice whose title code names one of our paper tenders is counted, not
  attached.** Live during this run: ՍԲԿՏ-ԳՀԱՊՁԲ-2026/7 (Sisian, one of the 14 local tenders,
  open until 10-27) got its amendment notice as `147bce3e.doc` → `unsupported_format`. The title's
  code would match it as reliably as a `.docx`'s, and the alert only needs to name the file, so
  attaching unreadable notices is a one-line change in `resolveAmendment` if wanted. Not done:
  the ticket says they count as `unsupported_format`. 32 of 60 uploads on the listing are `.doc`.
- **A same-minute re-upload with new bytes is an amendment.** Most quick re-uploads are
  byte-identical and stay one notice, but a buyer who fixes a typo four minutes after posting
  now sends an amendment alert four minutes after the match alert.
- **Amendment notices have no replay script.** The raw file and its listing page are stored, and
  `recordAmendment` reads only storage, so one is a loop over `amendment:` payloads with their
  notices; `normalize:replay` reads `detail:` refs only.
- **One buyer edit can still give two alerts** (ticket 18): the re-post (v2) and its notice (v3).
