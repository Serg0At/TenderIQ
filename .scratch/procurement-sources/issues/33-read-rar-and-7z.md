# 33 — Read gnumner files packed in .rar and .7z

**What to build:** A gnumner invitation, failure notice or contract notice packed in a `.rar` or
`.7z` archive, or in a `.rar` nested inside a `.zip`, is read the same way a `.docx` inside a
`.zip` is read today. The stored files already recorded as `unsupported_format` are replayed from
storage, so nothing is re-crawled. Found in ticket 13: 6 of 28 stored paper invitations (21%) are
unreadable. Each of those is a tender Tendra never shows, and one of them already turned into a
false "public miss" (ticket 09's ՍՀՏ-ԳՀԱՊՁԲ-2026/20).

**Blocked by:** None.

**Status:** done

Decided 2026-10-28, from ticket 13's file-by-file count:

- **unrar and 7z only.** These two are the only converters that recover invitations: unrar reads
  4 of the 6, and 7z the other 2. unrar also reads 6 failure notices and 3 contract notices.
- **LibreOffice for `.doc`: not now.** It mostly recovers failure statuses and 4 competitive
  contract prices, and it costs a headless office suite in the worker image. Decide on
  production counts.
- **OCR: never at these numbers.** All 6 scans are single source or failure notices.

## Acceptance

- [x] **Both libraries are pure JS/WASM**, so the worker image gains no system binary. Each is
      pinned to an exact version and lives behind the archive adapter in
      `libs/adapters/archive/`, beside `zip.js`. Nothing outside the adapter imports either one.
      *One library, not two:* `7z-wasm@1.2.0` (7-Zip 24.09 compiled to WASM) carries 7-Zip's
      unRAR decoder. It read every stored RAR4, RAR5 and 7z upload in about 10 ms each, so
      `node-unrar-js` was tried and removed. `libs/adapters/archive/sevenzip.js` is its only
      importer.
- [x] **The format comes from magic bytes, never the extension.** Ticket 13 found several
      mismatches:
  - most `.rar` files hold a `.docx`;
  - two `.zip` invitations hide the Armenian file in a nested `.rar`;
  - the one `.bin` is Word saved as HTML. That file stays unsupported.

  Every entry of an archive is told apart by its bytes as well (`word.js#wordDocuments`). A
  zip holding `[Content_Types].xml` is an Office file, so a `.docx` is read and an `.xlsx`
  skipped. Any other zip, `.rar` or `.7z` inside is an archive.
- [x] **Nesting goes at most two levels deep** (an archive inside an archive). Every entry obeys
      the decompressed-size ceiling the zip path already applies, or the equivalent one if the
      zip path has none, since an archive bomb is ordinary input from an untrusted upload. An
      encrypted or corrupt archive, or one past the limit, stays `unsupported_format`. It is
      never a crash and never a retry loop.
  - The cap is the zip path's 80 MB per entry, checked against the declared size before
    anything is unpacked, and measured again after.
  - New: 160 MB for the whole upload, across every layer. The zip path had no total, so many
    entries each just under 80 MB could fill the worker.
  - Tested by hand with: encrypted headers (`-mhe`, which makes 7-Zip throw out of WASM), an
    encrypted entry, a truncated RAR, non-archive bytes, and a cap below a real entry. Each
    is an `ArchiveError` and no documents. A fresh 7-Zip instance per archive keeps a thrown
    instance from being reused.
  - 7-Zip's exit hook writes `process.exitCode`, so the adapter restores it after each call.
  - A zip entry over the cap is still skipped rather than refusing the whole zip, as before.
  - Only an `ArchiveError` counts as unreadable. Anything else is thrown, so the job fails
    and retries; the WASM failing to load is the case in mind. Otherwise a broken install
    would silently count every `.rar` as `unsupported_format` (found in review).
  - One member a parser trips on still does not hide the others, as before.
- [x] **Only the Armenian template is read, as today.** A `.rar` holding an Armenian `.doc`
      beside a Russian `.docx` (3 of ticket 13's 12) stays `unsupported_format`. The Russian
      copy is not the template, and is never parsed as if it were. *Checked on the real
      files:*
  - both `.rar` contract notices of that shape stay unreadable;
  - failure notice `failed:22ef…` is the reverse (Armenian `.docx`, Russian `.doc`) and reads
    the Armenian one;
  - every bilingual `.rar` failure notice picked the Armenian `.docx`.
- [x] **Replay the stored rows.** Every open `unsupported_format` row goes back through its
      production handler from storage (`reason: 'retry'`), using the replay command built in
      ticket 32's follow-up if it fits. A row that now reads resolves. A row that still does not
      stays open, unchanged. Add the replay to ticket 30's list. *See* Replay *below.*
- [x] **Run `npm run sources:verify` before and after.** Paste both `unsupported_format` blocks
      here, per notice kind × procedure × extension. *See* Verification *below.*
- [x] **Update the comment for Sergey at the format check in `invitation.parser.js`.** It should
      say that .rar and .7z are now read, that .doc and scans are still counted, and why, with
      the count query kept. *The contract and failure parsers' format comments now say the
      same.*

## Built

- **`libs/adapters/archive/sevenzip.js`**: `unpack(bytes, { maxEntryBytes, maxTotalBytes })`
  returns every file as `{ path, bytes }`, or throws `ArchiveError` (`encrypted`,
  `too_large`, `corrupt` or `unreadable`). It lists first (`l -slt`), refuses before
  extracting, and gives each call a fresh instance.
- **`gnumner/word.js#wordDocuments` is async** and opens `.zip`, `.rar` and `.7z` to depth 2.
  So the three parsers, `observeInvitation`, `armeps/documents.js#buyerTaxIdOf` and their
  callers now `await`. The ARMEPS ՀՎՀՀ reader shares `word.js`, so a set's nested archives
  are read for the ՀՎՀՀ too.
- **A paper notice now records which file it uploaded.** This is the `upload:paper:{digest}`
  row in `source_payloads`, with the invitation's hash and key (`paper.js#recordUpload`), and
  it was the missing piece. An unreadable invitation has no tender, so no link says which
  notice listed it. A readable replay then has no publication to count its deadline from, and
  `observeInvitation` throws. The ticket 06 comment promised a `normalize:replay` path; that
  path could never have worked. The row is written on every fetch of the file.
  `reindexPayloads.js` records that a reindex cannot rebuild these rows, like `notice:` rows.
- **`npm run notices:replay` takes `--kind=invitation`.** It runs `normalize.tender` in
  process:
  - once per recorded notice, earliest publication first, with that notice as the discovery
    (`paper.js#storedInvitationJobs`);
  - for an older file that is already a tender, once with no discovery, since its links name
    the notices.

  Invitations run before contract and failure notices, so a tender an invitation creates is
  there for them. It runs at `RESULTS` priority, not `BACKFILL`, because gnumner's document
  stage, which writes the lots, skips backfill and costs no request.

## Replay (2026-10-29, local Postgres `tendra`, MinIO)

The 6 stored invitations predate the `upload:` row. Their notices were recovered from
`logs/combined.log`: each `invitation stored` line names its `notice` digest and its
`invitationId`. 6 rows were written from that, each checked against a stored `notice:` row,
with `fetched_at` = the file's. A second notice of one file is not logged, so only the first
is known. Neon holds no gnumner payloads (ticket 30, step 10), so nothing like this is needed
there.

`npm run notices:replay -- --unmatched=unsupported_format`:

```
5 invitation: tender created
1 invitation: unmatched unsupported_format
18 contract: unmatched unsupported_format
11 failed: unmatched unsupported_format
7 failed: unmatched no_candidate
```

- **Invitations: 5 of 6 now tenders**, all past their deadline (`closed`):
  - ՄՍԱԿ-ԳՀԱՊՁԲ-26/81 (`.rar`, 16 lots);
  - ՍՀՏ-ԳՀԱՊՁԲ-2026/20 (`.rar`);
  - ՄՍԱԿ-ԳՀԱՊՁԲ-26/83 (a `.rar` in a `.zip`, 2 lots);
  - ՊՄԱԹ-ԳՀԱՇՁԲ-26/42 (a `.rar` in a `.zip`);
  - ԳՄԳ8ՄԴ-ԳՀԱՇՁԲ-26/02 (`.7z`, 1 lot).

  The sixth is a `.7z` holding two `.xls` and a PDF, with no Word file. Ticket 13 could not
  list it (headers compressed) and counted it for 7z; it stays `unsupported_format`.
- **Failure notices: all 7 `.rar` now read**, and none matches a tender Tendra holds. They
  are `no_candidate` now, the honest reason: their invitations were never swept.
- **Contract notices: 0 more.** Ticket 13 expected unrar to read 3. Two hold an Armenian
  `.doc` beside a Russian `.docx`, and the third holds two PDFs.
- **Ticket 09's false public miss is gone.** Creating ՍՀՏ-ԳՀԱՊՁԲ-2026/20 queued a retry of
  its failure notice, as `queueResultRetries` does.
  - That retry, and the 5 document jobs, were run in process from the queue and then removed.
    They read storage only. No worker was started, because 1,857 queued fetches would have
    gone to the live sources.
  - The notice linked. The tender stays `closed`, not `cancelled`, because its invitation's
    lot table is not read (0 lots), and "no lots known → not cancelled yet" (ticket 09).
- **The 5 `match.tender` jobs were left queued**, as production would leave them.
- **Every tender that existed before is byte-identical:** md5 over id, version, status,
  deadline, publication, buyer, CPV and title. The only writes are the 5 tenders, their 5
  detail links, 5 discovery links, 1 results link and 19 lots. On the unmatched rows:
  - 5 invitation rows resolved;
  - 7 failure rows moved from `unsupported_format` to `no_candidate`;
  - 1 of those 7 resolved.
- **Idempotent.** A second run of the same command leaves the same 30 rows open.
  `notices:replay -- --kind=invitation` over all 28 stored invitations gives "27 linked
  (status unchanged), 1 unsupported_format" and the snapshot does not move. It queued nothing.
- **Parsers agree on everything that read before.** The HEAD and new parsers were run over
  all 113 stored gnumner uploads (invitations, contract, failure and amendment notices):
  - 101 give identical output;
  - 12 changed, all from unreadable to readable: the 5 invitations and the 7 failure notices.
- **The fetch path records its notice.** `handlePaperInvitation` was run against a stored
  notice, with the HTTP client stubbed by a loader hook to return the stored bytes, so
  gnumner was never asked. It wrote `upload:paper:d0ac…` with the file's hash and key. Its
  queued renormalize was removed.
- **`npm run buyers:merge` (dry run)** reads every stored set through the async ՀՎՀՀ reader.
  It reports 0 failed and the same refused group (01506928).

Two of the new tenders show the parser's limits, not the format's:

- ՊՄԱԹ-ԳՀԱՇՁԲ-26/42 states no deadline sentence, so the listing's close is used and warned.
- ՊՄԱԹ-ԳՀԱՇՁԲ-26/42 and ՍՀՏ-ԳՀԱՊՁԲ-2026/20 have a lot table the invitation parser does not
  find.

## Verification

`npm run sources:verify`, everything. Before:

```
  gnumner: created 21 tenders, linked to 74 (links: 22 detail, 81 discovery, 5 results)
    unmatched no_candidate          31 open (1 public, 30 unknown), 4 since taken by a tender
    unmatched no_code                4 open (1 never public, 3 unknown)
    unmatched unsupported_format    42 open (11 never public, 1 public, 30 unknown), 1 since taken by a tender
    missed tenders (no_candidate, public): 1

— unsupported_format, open, by notice kind × procedure × extension —
  contract (18)
    competitive      6: doc 4, docx 1, pdf 1
    single_source   11: doc 4, pdf 4, rar 2, zip 1
    unknown          1: rar 1
  failed (18)
    competitive     17: rar 7, doc 4, zip 4, bin 1, pdf 1
    unknown          1: doc 1
  invitation (6)
    competitive      1: rar 1
    unknown          5: 7z 2, zip 2, rar 1
  by extension (not single-source / all): doc 9/13, rar 10/12, zip 6/7, pdf 2/6, 7z 2/2, docx 1/1, bin 1/1
```

After:

```
  gnumner: created 26 tenders, linked to 79 (links: 27 detail, 86 discovery, 6 results)
    unmatched no_candidate          37 open (37 unknown), 5 since taken by a tender
    unmatched no_code                4 open (1 never public, 3 unknown)
    unmatched unsupported_format    30 open (11 never public, 1 public, 18 unknown), 6 since taken by a tender
    missed tenders (no_candidate, public): 0

— unsupported_format, open, by notice kind × procedure × extension —
  contract (18)
    competitive      6: doc 4, docx 1, pdf 1
    single_source   11: doc 4, pdf 4, rar 2, zip 1
    unknown          1: rar 1
  failed (11)
    competitive     10: doc 4, zip 4, bin 1, pdf 1
    unknown          1: doc 1
  invitation (1)
    competitive      1: 7z 1
  by extension (not single-source / all): doc 9/13, pdf 2/6, zip 4/5, rar 1/3, docx 1/1, bin 1/1, 7z 1/1

  paper        26: active 1, awarded 2, cancelled 2, closed 21   (was 21: … closed 16)
```

The invitation that was "unknown" is now "competitive": a replay reads its notice, and its
listing names the procedure.

What is left is mostly LibreOffice's: `.doc` 13, plus an Armenian `.doc` beside a Russian
`.docx` inside a `.zip` or `.rar`. The rest is PDFs. That is the decision the format comment
leaves open for production counts.

## For the owner

- **The `upload:` row is a new kind of `source_payloads` row.** It points at the invitation's
  own object rather than one of its own, as a `notice:` row points at its listing page.
  Nothing that reads `source_payloads` by prefix is affected (`detail:`, `listing:`,
  `contract:`, `failed:`, the format-count join). A reindex cannot rebuild it.
- **`normalize:replay` is not the way to replay an unreadable invitation.** Without a notice it
  has no deadline to count, so a newly readable file with no tender throws there.
  `notices:replay` is the command, and the parser comment now says so.

## Out of scope

- `.doc` (LibreOffice), PDF text layers, OCR.
