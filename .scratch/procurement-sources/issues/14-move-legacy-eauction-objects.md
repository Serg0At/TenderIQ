# 14 — Move the e-auction objects out of `raw/armeps/` and `docs/armeps/`

**What to build:** Every e-auction object lives under the `eauction` folder, so the `armeps` storage
folders are empty and free for armeps.am (ticket 05). The one exception ticket 01 left, reindex's
legacy folder map, disappears. Decided by the owner on 2026-10-19 over two alternatives: naming
armeps.am's source `epps`, or giving it a non-standard folder. The reason: while Tendra is still in
development, one rule ("folder = source") is worth a one-off copy. Ticket 01's *Verification* notes
explain why the objects were not moved then.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] A one-off, run-twice-safe script copies every object under `raw/armeps/` and
      `docs/armeps/` to the same path under `eauction`, through the storage port only, never the
      AWS SDK directly.
- [ ] Order: **copy → verify (size, and content hash where the key carries one) → update the rows
      → verify again → delete the old object.** No old object is deleted before the row pointing
      at it has been moved and re-checked. A run that dies mid-way leaves every row pointing at
      an object that exists.
- [ ] Rows updated: `source_payloads.storage_key` and `tender_documents.storage_key`. Nothing else
      stores these keys; grep for other readers before relying on that.
- [ ] Afterwards `raw/armeps/` and `docs/armeps/` are empty, and no row references them.
- [ ] Reindex's `LEGACY_STORAGE_FOLDERS` map is removed, along with the paragraphs in CLAUDE.md and
      docs/SCRAPER_WORKFLOW.md that explain it.
- [ ] `npm run normalize:replay` changes nothing (diff against a canonical dump, as ticket 01 did).
      A stored invitation file still downloads through the tender documents endpoint, and
      `npm run reindex` (dry run) maps every object to `eauction`.
- [ ] The workers are stopped while it runs.
- [ ] **Neon and its bucket are not touched.** Record in this ticket that whoever migrates Neon
      runs ticket 01's script and then this one, against that environment's database and bucket.
      Keep the script recoverable via `git show` and delete it after it is applied, per the
      schema workflow.
- [ ] Counts recorded here: objects copied, rows updated and objects deleted, per folder.
