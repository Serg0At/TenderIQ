# 01 — The CPV classifier is loaded and names every code

**What to build:** Armenia's official CPV classifier («Գնումների միասնական անվանացանկ», published
by the Ministry of Finance on gnumner.minfin.am as an `.xls`) is in the database. The owner can
refresh it by hand and see what changed before applying. Every code the API shows, stated today
and inferred later, carries its Armenian name. This is the closed set every inferred code will
be chosen from (ADR 0006). See `.scratch/cpv-inference/spec.md`, *The CPV classifier*.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] `cpv_classifier` (8-digit code primary key, Armenian name, nullable unit, classifier
      version = the ministry file's date, and whether the code came from the e-auction subset)
      is written straight into `create_table.js` / `drop_table.js`, with a trigram index on the
      name; `pg_trgm` is enabled beside `btree_gist`.
- [x] A gnumner source adapter finds the classifier's current link on the site rather than
      hardcoding the file name, which changes with every update. TLS uses the intermediate
      certificate in `certs/`; never `rejectUnauthorized: false`.
- [x] The code sheet is read as code, name and unit. Names are transcoded from ArmSCII-8 font
      encoding stored as Latin-1, with byte 0xA8 → «և». Float-typed codes are zero-padded to 8
      digits.
- [x] The e-auction subset's codes missing from the full list (today only `44421700` «արկղեր»)
      are merged in and marked.
- [x] `npm run cpv:refresh` is a dry run by default and reports codes added, removed and renamed
      against the stored version. `--apply` writes it in one transaction and touches no tender or
      lot. A code the new file drops is marked withdrawn, never deleted: ticket 02's lots
      reference the table, and an inferred code must keep resolving to its name. A withdrawn
      code is never offered as a candidate.
- [x] The tender detail and its lots answer `cpvName` beside each stated code (null for a code
      the classifier lacks); `docs/API_REFERENCE.md` documents it.
- [x] Verified by hand on the local `tendra` database: the apply loads 11,386 codes plus the
      e-auction extra; `32341334` reads «ալեհավաք» and `44163140` «ջրի և գոլորշու խողովակներ»;
      every distinct stated lot code in the database has a name; a second dry run reports no
      changes.

## Done — 2026-11-13

Verified on the local `tendra` database, the schema on a scratch database built from
`create_table.js` and dropped with `drop_table.js`.

- **The reader is our own.** Nothing in the dependency tree reads BIFF8 `.xls`, and SheetJS's
  npm copy is frozen at 0.18.5 with known CVEs, so `libs/adapters/spreadsheet/xls.js` reads the
  Compound File and the cell records itself (SST across CONTINUE, LABELSST, NUMBER, RK, MULRK,
  LABEL, cached FORMULA results). It matched Python's xlrd on all 54,006 cells of both files,
  and refuses `.xlsx`, BIFF5 and encrypted files with a reason.
- **The font is decoded per character** (`libs/armscii.js`): one cell can mix font bytes,
  genuine Unicode Armenian, Cyrillic and real Latin. Beyond 0xA8 → «և», the file showed "`" →
  «՝» (349 times) and 0xAD as a soft hyphen at syllable breaks, dropped. 0 names left with an
  unmapped character.
- **The links** are found by their labels in the home page's footer («…միասնական
  անվանացանկ»; «Էլեկտրոնային աճուրդի … CPV»); the version is the date the file name states
  (`CPV-11.11.2026.xls` → 2026-11-11), else its Last-Modified day. The code sheet is the one
  whose first column holds the most codes ("Sheet2" of three).
- **The apply** wrote 11,387 rows: 11,386 + `44421700` «արկղեր» marked `eauction_only`. Where
  both files name a code the full list wins; 47 names differ, all its spelling fixes.
  `32341334` «ալեհավաք», `44163140` «ջրի և գոլորշու խողովակներ». All 2,393 distinct stated lot
  codes (2,495 stated codes in all) have a name. The second dry run: no changes.
- **Withdrawal** was exercised on the scratch database: a stored code the file lacks is kept
  with `withdrawn_in` = the new version, a withdrawn code listed again is restored, and renames
  and unit changes are reported; a file older than the stored version is refused.
- **For ticket 02:** "a withdrawn code is never offered as a candidate" holds only if the
  candidate query filters `withdrawn_in IS NULL` — this ticket adds the column, and there is no
  candidate query yet.
- **API:** the detail answers `cpvName` (tender and lot) and `cpvNames` (code → name over
  `cpvCodes`), so `cpvCodes` keeps its shape. `45233120` (EU: road surfacing) is not in
  Armenia's classifier — the example in `API_REFERENCE.md` shows its `null`.
