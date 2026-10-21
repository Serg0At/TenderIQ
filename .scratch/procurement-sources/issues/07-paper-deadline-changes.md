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
- [x] ~~Unreadable amendment files count as `unsupported_format`.~~ **Reversed 2026-10-21** (see
      *Follow-up* below): a notice's content is never read, so it attaches whatever its format;
      `unsupported_format` stays for files whose content must be read (invitations, contract
      notices).
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
- **`tender_sources.points_to`** (`git show 01563d9:migrations/add_tender_source_points_to.js`, run twice on `tendra`, mirrored into `create_table.js`, deleted in the next commit; Neon is ticket 30 step 9): a notice link records which link it is a
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

- **A same-minute re-upload with new bytes is an amendment.** Most quick re-uploads are
  byte-identical and stay one notice, but a buyer who fixes a typo four minutes after posting
  now sends an amendment alert four minutes after the match alert.
- **Amendment notices have no replay script.** The raw file and its listing page are stored, and
  `recordAmendment` reads only storage, so one is a loop over `amendment:` payloads with their
  notices; `normalize:replay` reads `detail:` refs only.
- **One buyer edit can still give two alerts** (ticket 18): the re-post (v2) and its notice (v3).

## Follow-up: a notice attaches whatever its format (decided 2026-10-21)

**Decision.** An amendment notice whose title code matches an open paper tender is attached
whatever its format: the `.doc`, `.rar` or `.pdf` is stored as it is, listed as an `amendment`
document and named in the alert. A notice's content is never read, so its format does not
matter; `unsupported_format` stays for files whose content Tendra must read (invitations,
contract notices). A notice whose title names no code stays unmatched (`no_code`).

**What changed.**
- `resolveAmendment` has no format check. `observeAmendment` is built from the listing notice
  alone — the code is the title's — and `parseAmendmentNotice` is gone: nothing reads the file.
- The worker serves the stored file from a ZIP like every document: an archive of files as it
  is, anything else (`.docx`, `.doc`, `.pdf`, `.rar`) as the one entry of one. An Office file is
  told from an archive by its packaging (`[Content_Types].xml`, `invitation.files.js#isOfficeFile`),
  never its text. A blank upload name falls back to `amendment.{ext}`, not `invitation.docx`.
- The format-count query in `invitation.parser.js` leaves out resolved rows.

**One counted consequence of title-only codes** (both resolved by the second follow-up below).
Of the 22 stored notices, `69abad6b.docx` names no code in its title and its body's was no longer
read, and `3c33597c.pdf`'s title spells its code without the dash after `ՁԲ`: both `no_code`.

**Verified (2026-10-21, local `tendra`, MinIO, live gnumner).** The pure checks: 32 assertions,
including an unreadable `.doc`/`.rar` notice of an open paper tender → `link`, the same with no
candidate → `no_candidate`, with no title code → `no_code`, and an unreadable *invitation* still
`unsupported_format`.

**ՍԲԿՏ-ԳՀԱՊՁԲ-2026/7** («Սիսիանի բնակարանային կոմունալ տնտեսություն» ՀՈԱԿ, open until 10-27
11:00): its notice `147bce3e.doc` (published 10-21 17:18, a `.doc`, 68,096 bytes), re-run through
the production `handlePaperAmendment` with its job rebuilt from the stored listing page:

| | before | after |
|---|---|---|
| version / status | 1 / `active` | **2 / `amended`** |
| documents | the invitation (3 files) | plus kind `amendment`: `147bce3e.doc` |
| alert jobs | `match-…-v1` | plus exactly one: `match-…-v2`, `changedFields: []`, `added: ["147bce3e.doc"]` |
| unmatched row | `unsupported_format` | resolved to the tender |

- `GET` of that document through `TenderService.documentFile` streamed 68,096 bytes, sha256 equal
  to the stored raw `.doc` (header `d0cf11e0`).
- Run again: still v2; the v2 alert re-queued under its own id, absorbed.
- The matcher with a throwaway organization and saved search on `աղբաման`: 1 `tender-match`, then
  **1 `amendment`**, «new document: 147bce3e.doc»; every job a second time: 0. Throwaway rows
  deleted.

**Every stored notice re-run** (22, jobs rebuilt from the stored listing pages by the board's
`toNotice`): 2 attached (ՍԲԿՏ v2 with an alert; ԵՊՊՔ already v3, nothing new), 11
`other_channel`, 7 `no_candidate`, 2 `no_code`, **0 `unsupported_format`**. The old
`unsupported_format` rows became `no_candidate` on re-read, except ՍԲԿՏ's, now resolved.

`normalize:replay` afterwards over 1,229 payloads: 1,222 unchanged + 5 unmatched (the unreadable
invitations, still `unsupported_format`) + 2 superseded; every checksum identical.

## Second follow-up: a code the title lacks, and ՁԲ straight into a digit (decided 2026-10-21)

**Decisions.** (1) A notice's code is its title's; if the title has none and the file is a
readable `.docx` (or one in a `.zip`), the code is read from its body; otherwise `no_code`. The
format still never blocks a notice whose code is known. (2) A code whose marker `ՁԲ` runs straight
into a digit (`ՄԿԻ-ԳՀԱՊՁԲ26/47`) is read, and keyed as if the dash were there: only that position,
never another dash.

**What changed.**
- `invitation.parser.js#noticeBodyCode`: the «Ընթացակարգի ծածկագիրը …» code of a Word document,
  null for anything else. `recordAmendment` calls it only when the title gave no code, and
  `observeAmendment` takes it as `bodyCode`, behind the title's.
- `listing.parser.js` `CODE_RE`: after `ՁԲ`, either the letters-then-dash segments it always
  read, or a digit directly. A letter after `ՁԲ` with no dash (`ԳՀԱՊՁԲԱ26`) and a space instead
  of a dash (`ԳՀԱՊՁԲ 26/3`) are still no code. The invitation parser's code goes through the same
  function.
- `normalizeCode` ends `.replace(/ՁԲ(?=[0-9])/g, 'ՁԲ-')`; `codeKeySql` (now exported, as
  `tenderCodesSql` is) ends `regexp_replace(…, 'ՁԲ([0-9])', 'ՁԲ-\1', 'g')`. **Not the lookahead in
  SQL**: the first version used `(?=[0-9])` there too, and the key check below failed with
  «Expected 1 bindings, saw 2» — knex reads that `?` as a binding, so every code lookup in
  `findCandidates` would have thrown. The comment says so.

**Verified (2026-10-21, local `tendra`).**
- **JS and SQL keys agree**, as ticket 03 checked them: 1,227 stored codes (every
  `tenders.reference_code` and `unmatched_results.procedure_code`, plus four constructed) in
  11,836 variants — each code quoted «», "", with en and em dashes, padded and double-spaced, and
  for every `ՁԲ-<digit>` code its dash-less form, quoted, en-dashed and with an en dash in that
  position: **0 mismatches**; all **3,495** dash-less forms key exactly as the dashed spelling.
  The live path too: `findCandidates` on `ԵՊՊՔ-ԳՀԱՊՁԲ26-3` and on `«ԵՊՊՔ–ԳՀԱՊՁԲ-26-3»` both return
  the ԵՊՊՔ tender, by code and by run.
- **Stored readings that change**: every code the gnumner parsers read from storage (165 listing
  titles and invitations), before and after: exactly 2 differ, both from none to a code —
  the ՄԿԻ notice and the ARMEPS title «ԿՄՆՀՀ ԳՀԾՁԲ26/62», read as `ԳՀԾՁԲ26/62` because the
  long-standing buyer-prefix cap (two words of at most four letters) drops a five-letter one. That
  notice links by its armeps.am pointer, never by code. No paper invitation's code changed.
- **14 stored tenders are written with no dash after `ՁԲ`** — 13 e-auctions (`ԱԲԿ26-ԷԱՃԱՊՁԲ11/1`,
  `ԿՄՆՀՀ ԷԱՃԱՊՁԲ26/50`, `ՀՀ ՏՄՆՀՀ-ԷԱՃԱՊՁԲ26/29` …) and the ARMEPS `ԿՄՆՀՀ ԳՀԾՁԲ26/62`. Their key now
  carries the dash in both twins; keys are computed at query time, so nothing stored moves, and a
  dashed spelling of the same code from another source now finds them.
- The pure checks: 34 assertions (title first, body only without a title code, null otherwise;
  the ՁԲ+digit forms read and keyed; letter-after-ՁԲ, space-for-dash and an already dashed code
  untouched).
- `normalize:replay`, 1,229 payloads: 1,222 unchanged + 5 unmatched + 2 superseded, checksums
  identical.

**The two notices re-run** (jobs rebuilt from the stored listing pages, the production handler):

| notice | before | now |
|---|---|---|
| `69abad6b.docx`, title with no code | `no_code` | code from its body, `ՆԳՆ Կ ԳՀԱՊՁԲ-26/14` → **`no_candidate`** |
| `3c33597c.pdf`, title `ՄԿԻ-ԳՀԱՊՁԲ26/47` | `no_code` | code from its title → **`no_candidate`** (a `.pdf`: the format did not block it) |

Neither attaches here because `tendra` holds neither tender (no `ՄԿԻ-…` or `…ՆԳՆ Կ…` code is stored):
`no_candidate` is the honest answer, and it is what a missed tender looks like. That a dash-less
code finds a stored tender is the `findCandidates` check above.
