# 01 — The CPV classifier is loaded and names every code

**What to build:** Armenia's official CPV classifier («Գնումների միասնական անվանացանկ», published
by the Ministry of Finance on gnumner.minfin.am as an `.xls`) is in the database. The owner can
refresh it by hand and see what changed before applying. Every code the API shows, stated today
and inferred later, carries its Armenian name. This is the closed set every inferred code will
be chosen from (ADR 0006). See `.scratch/cpv-inference/spec.md`, *The CPV classifier*.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `cpv_classifier` (8-digit code primary key, Armenian name, nullable unit, classifier
      version = the ministry file's date, and whether the code came from the e-auction subset)
      is written straight into `create_table.js` / `drop_table.js`, with a trigram index on the
      name; `pg_trgm` is enabled beside `btree_gist`.
- [ ] A gnumner source adapter finds the classifier's current link on the site rather than
      hardcoding the file name, which changes with every update. TLS uses the intermediate
      certificate in `certs/`; never `rejectUnauthorized: false`.
- [ ] The code sheet is read as code, name and unit. Names are transcoded from ArmSCII-8 font
      encoding stored as Latin-1, with byte 0xA8 → «և». Float-typed codes are zero-padded to 8
      digits.
- [ ] The e-auction subset's codes missing from the full list (today only `44421700` «արկղեր»)
      are merged in and marked.
- [ ] `npm run cpv:refresh` is a dry run by default and reports codes added, removed and renamed
      against the stored version. `--apply` writes it in one transaction and touches no tender or
      lot. A code the new file drops is marked withdrawn, never deleted: ticket 02's lots
      reference the table, and an inferred code must keep resolving to its name. A withdrawn
      code is never offered as a candidate.
- [ ] The tender detail and its lots answer `cpvName` beside each stated code (null for a code
      the classifier lacks); `docs/API_REFERENCE.md` documents it.
- [ ] Verified by hand on the local `tendra` database: the apply loads 11,386 codes plus the
      e-auction extra; `32341334` reads «ալեհավաք» and `44163140` «ջրի և գոլորշու խողովակներ»;
      every distinct stated lot code in the database has a name; a second dry run reports no
      changes.
