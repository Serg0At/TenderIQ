# 01 — Rename the source key `armeps` to `eauction`

**What to build:** The e-auction source is called `eauction` everywhere it appears as data or
configuration, so that `armeps` can later mean armeps.am without one name meaning two websites.
Ingestion, replay and every reader behave exactly as before. Spec: *The rename comes first*. ADR 0004.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] Data is renamed through an additive, run-twice-safe script, following the four-step schema
      workflow in CLAUDE.md. That covers the `tenders.source_id` prefixes, `source_payloads.source`,
      the `parties.source_id` prefixes, and the `source` values and column defaults in `awards`,
      `public_tender_bids` and the other ledger tables.
- [x] `create_table.js` carries the new defaults, and the script is deleted once applied.
- [x] The sources config key, the adapter folder, the Redis sweep, watermark and freshness keys,
      and every code literal use `eauction`. Existing Redis watermarks carry over, so the next sweep
      does not cold-start.
- [x] Stored objects are not moved. `source_payloads` still points at the existing storage keys,
      and new payloads are written under the new prefix.
- [x] `npm run normalize:replay` on the local DB produces no changes to any tender, ledger row or
      award.
- [x] A live sweep after the rename writes 0 rows and enqueues 0 jobs for unchanged tenders.
- [x] No reference to the old key remains outside git history and this ticket. Check with grep.
- [x] CLAUDE.md and docs/SCRAPER_WORKFLOW.md name the source `eauction`.

## Verification — 2026-10-19

Run against the local database `tendra` and the local Redis, with the workers stopped.

**Rename script** (`migrations/rename_source_eauction.js`, commit `5f0bd43`, deleted in the
next commit; recover it with `git show 5f0bd43:migrations/rename_source_eauction.js`):

| | first run | second and third runs |
|---|---|---|
| `tenders.source_id` | 1152 | 0 |
| `parties.source_id` | 939 | 0 |
| `source_payloads.source` (0 duplicates dropped) | 3615 | 0 |
| `awards` / `public_tender_bids` / `tender_lots` `.source` | 5580 / 19978 / 10161 | 0 |
| Redis `sweep:ok` carried over (TTL kept) | yes | no-op |
| old job schedulers removed (`sweep-armeps`, `refresh-armeps`) | 2 | 0 |
| pending `ingest.fetch` jobs re-added under `eauction` (18 detail, 501 docs, 36 listing pages; priority kept) | 555 | 0 |

After the run, a scan of every text, json and array column finds `armeps` only in URLs
(`eauction.armeps.am`) and in storage keys (`raw/armeps/…`, `docs/armeps/…`), which are not
moved. The column defaults are now `'eauction'`. There was no `sweep:tid:armeps:*` watermark
locally: the last chain was a cold start that had not finished, and its `highTid` (48190) travels
in the job data that was migrated. `carryMax` keeps the larger value if a watermark does exist. One
dead-lettered `armeps` job was left in `failed` on purpose, as the record of what failed. About
1,700 completed job hashes with `armeps-` ids remain; they age out on their own.

**Replay.** `npm run normalize:replay` was diffed before and after against a canonical dump of
`tenders`, `parties`, `awards`, `public_tender_bids` and `tender_lots`, with the source key
normalised and timestamps and regenerated ledger ids excluded.

- The first replay **failed** this check, and not because of the rename. 958 tenders came back
  `TenderAmended` with `cpv_code` set to NULL and `version` incremented, and 958 `match.tender`
  alert jobs were queued. The cause predates the rename: the normalizer always sends
  `cpvCode: null`, because the detail page carries no CPV, and `saveNormalized` both fingerprints
  `cpv_code` and overwrites it. So any re-normalize of a tender whose CPV came from the invitation
  archive wiped that CPV and re-notified it as amended. A live `tender.refresh` of a changed page
  did the same thing. The alert jobs were removed before any worker ran, and `cpv_code` and
  `version` were restored from the dump.
- Fixed in `tender.repo.js` `saveNormalized` (separate commit): a detail page with no CPV keeps
  the stored one.
- Second replay: 1152 jobs, **1152 unchanged, 0 events, 0 alert jobs, 0 failures**. The dump is
  identical to the pre-rename one.

**Live sweep.** One real `source.sweep` and its page-1 `listing.page` were run through the
production handler. 30 blocks, 30 usable. The 10 tenders already known (tid ≤ 48190) wrote
**0 notice rows and enqueued 0 detail jobs**. The other 20 (tids 48191–48214) were new
publications, never seen before and not in `tenders`, and were correctly enqueued, plus page 2
because the cold start is still running. `sweep:ok:eauction` was written; `sweep:ok:armeps` no
longer exists. `npm run scheduler` then registered `sweep-eauction` and `refresh-eauction`.

**Reindex.** `parseRawKey('raw/armeps/…')` and `parseRawKey('raw/eauction/…')` both return
`source: 'eauction'`.

**Grep.** `armeps` remains outside `.scratch/`, the ADR and hostnames in only one place: the
`LEGACY_STORAGE_FOLDERS` map in `src/scripts/reindexPayloads.js` and the docs that explain it
(CLAUDE.md and SCRAPER_WORKFLOW.md). It is deliberate: the objects were not moved, so the one
reader that derives a source from a key has to know the old folder name.

**Not done here:**

- **Neon is not migrated.** It still holds 851 `armeps:` tenders and 2806 `armeps` payloads (last
  fetch 2026-09-14). It is a shared database the deployed API may read, so it was left alone.
  Before pointing new code at it, stop anything writing to it, recover the script with the
  `git show` above, and run it with the Neon `PSQL_*` and that environment's `REDIS_*`.
- The env vars are now `SOURCE_EAUCTION_{BASE,CRON,REFRESH_CRON,DETAIL_BASE}`. Local `.env` was
  renamed. Any deployed environment that still sets `SOURCE_ARMEPS_*` now silently gets the
  defaults. The local `SOURCE_EAUCTION_BASE` value is the listing URL
  (`…/hy/public/tender/`), not the origin the code expects, and was kept as it was.
- **For ticket 05:** armeps.am must not write under `raw/armeps/` or `docs/armeps/`, or reindex
  cannot tell its objects from the e-auction ones.
