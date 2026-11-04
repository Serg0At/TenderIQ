# 14 — Move the e-auction objects out of `raw/armeps/` and `docs/armeps/`

**What to build:** Every e-auction object lives under the `eauction` folder, so the `armeps` storage
folders are empty and free for armeps.am (ticket 05). The one exception ticket 01 left, reindex's
legacy folder map, disappears. Decided by the owner on 2026-10-19 over two alternatives: naming
armeps.am's source `epps`, or giving it a non-standard folder. The reason: while Tendra is still in
development, one rule ("folder = source") is worth a one-off copy. Ticket 01's *Verification* notes
explain why the objects were not moved then.

**Blocked by:** 01

**Status:** done

- [x] A one-off, run-twice-safe script copies every object under `raw/armeps/` and
      `docs/armeps/` to the same path under `eauction`, through the storage port only, never the
      AWS SDK directly.
- [x] Order: **copy → verify (size, and content hash where the key carries one) → update the rows
      → verify again → delete the old object.** No old object is deleted before the row pointing
      at it has been moved and re-checked. A run that dies mid-way leaves every row pointing at
      an object that exists.
- [x] Rows updated: `source_payloads.storage_key` and `tender_documents.storage_key`. Nothing else
      stores these keys; grep for other readers before relying on that.
- [x] Afterwards `raw/armeps/` and `docs/armeps/` are empty, and no row references them.
- [x] Reindex's `LEGACY_STORAGE_FOLDERS` map is removed, along with the paragraphs in CLAUDE.md and
      docs/SCRAPER_WORKFLOW.md that explain it.
- [x] `npm run normalize:replay` changes nothing (diff against a canonical dump, as ticket 01 did).
      A stored invitation file still downloads through the tender documents endpoint, and
      `npm run reindex` (dry run) maps every object to `eauction`.
- [x] The workers are stopped while it runs.
- [x] **Neon and its bucket are not touched.** Record in this ticket that whoever migrates Neon
      runs ticket 01's script and then this one, against that environment's database and bucket.
      Keep the script recoverable via `git show` and delete it after it is applied, per the
      schema workflow.
- [x] Counts recorded here: objects copied, rows updated and objects deleted, per folder.

## Verification — 2026-10-19

Run against the local database `tendra` and the local MinIO bucket `tenderiq`, with the workers
stopped (the script refuses to run while any worker is connected to a queue).

The ticket says `docs/armeps/`; the folder is actually `tender-docs/armeps/` (`PREFIX.TENDER_DOCS`).
It holds the invitation `.zip` and, beside it, the extracted `.txt` that aiExtractor finds by
swapping the archive key's extension. The `.txt` has no row, so the script copies the whole folder
before moving any row, and an archive's row never points at a key whose sidecar is not there yet.

**Move script** (`migrations/move_eauction_objects.js`, commit `2372170`, deleted in the next
commit; recover it with `git show 2372170:migrations/move_eauction_objects.js`):

| | `raw/armeps/` | `tender-docs/armeps/` | second run |
|---|---|---|---|
| objects found | 2373 (`.html`) | 2966 (1483 `.zip` + 1483 `.txt`) | 0 |
| objects copied and verified | 2373 | 2966 | 0 |
| failed hash or size check | 0 | 0 | 0 |
| `source_payloads.storage_key` updated | 2528 | 1087 | 0 |
| `tender_documents.storage_key` updated | 0 | 1087 | 0 |
| old objects deleted | 2373 | 2966 | 0 |

More rows than objects in `raw/`: the `notice:` listing rows share one listing-page object. Fewer
rows than objects in `tender-docs/`: 396 archives were stored without a row (older content hashes
of a re-issued invitation); they were moved too. Afterwards both old folders hold 0 objects and
0 rows in either table name them. No row anywhere names an object that is missing.

**Replay.** `npm run normalize:replay` queued 1152 jobs, drained by the production
`normalizeTender` handler on the normalize queue only: **1152 unchanged, 0 events, 0 failures,
0 new alert jobs.** A canonical dump of `tenders`, `parties`, `awards`, `public_tender_bids`,
`tender_lots` and `tender_documents` (ids and timestamps of the ledger excluded, storage keys
excluded) is byte-identical before the move and after the replay.

**Documents.** Five random stored invitations opened through `TenderDocumentService.openFile` (the
handler behind `GET /tenders/:id/documents/:documentId/files/:index`); every streamed file's size
equals its manifest entry.

**Reindex.** `LEGACY_STORAGE_FOLDERS` is gone; `parseRawKey` takes the folder as the source. Dry
run (parse every `raw/` key, write nothing): 2374 `eauction` (the 2373 moved plus the one already
written under `raw/eauction/` since ticket 01), 10 `gnumner`, 0 skipped. The
paragraphs explaining the map are gone from CLAUDE.md and docs/SCRAPER_WORKFLOW.md.

**After review** the script gained three guards that this run did not need but a Neon run might:
an archive and its `.txt` are held back together if either fails (otherwise a moved row could name
a key with no sidecar, or a sidecar could be deleted from beside an archive left in place); an
old-key `tender_documents` row is dropped when the tender already names the new key, rather than
colliding with `UNIQUE (tender_id, storage_key)` and rolling back the batch; and a throw on one
object is counted instead of failing the pool. They were checked on a fixture before the script was
deleted: one archive pair and one raw payload moved back under `armeps` with their rows, plus a
corrupt archive pair. The real pair and payload moved and their rows followed. The corrupt archive
and its sidecar both stayed in place, and the run exited non-zero. The fixture was then removed and
the checks above re-run, with the same result.

**Left alone:** 1000 completed `ingest.normalize` job hashes still carry `raw/armeps/` keys in their
data; they are history and age out on their own. Two stale `armeps-docs-*` ids sit in
`ingest.fetch:active` from before ticket 01 — not touched here.

**Neon is not touched.** Whoever migrates Neon must, with everything that writes to it stopped, run
ticket 01's script (`git show 5f0bd43:migrations/rename_source_eauction.js`) and **then** this one
(`git show 2372170:migrations/move_eauction_objects.js`), each with that environment's `PSQL_*`,
`REDIS_*` and `S3_*` / `STORAGE_DRIVER`, so the database and the bucket it points at move together.
Running this one against the Neon database with the local bucket would find nothing to copy and
change nothing; running it against the right bucket with the wrong database would delete objects
no local row names — so check both before starting. Until it has run there, do not run
`npm run reindex` against Neon's bucket: the legacy folder map is gone, so `raw/armeps/` objects
would be indexed as source `armeps`.
