# 30 — Bring Neon and the deployed environment up to date

**What to build:** The deployed database, bucket, Redis and environment variables reach the shape
the code now expects, in the order that keeps each step valid. Every ticket in this feature ran
its migration on local `tendra` only and wrote "Neon is not touched". This is the one list of
everything those tickets deferred, so a deploy cannot miss a step or run them out of order.

**Blocked by:** None. Do it immediately before deploying the code from these tickets, not earlier:
a migrated Neon under old code breaks the old code.

**Status:** ready-for-human

It needs the owner: these steps act on the shared database and bucket.

**Before anything:** stop every process that writes to Neon (the API, workers, scheduler). Back up
Neon (a branch or a dump). Point `PSQL_*`, `REDIS_*`, `S3_*` and `STORAGE_DRIVER` at the deployed
environment, and **check all four before each step**. Ticket 14 explains what a database and
bucket mismatch deletes.

Run in this order. Recover each script with `git show <commit>:<path>`, run it, then run it a
second time to confirm it is a no-op:

- [ ] 1. `5f0bd43:migrations/rename_source_eauction.js`: `armeps` → `eauction` in data and Redis
      (ticket 01).
- [ ] 2. `2372170:migrations/move_eauction_objects.js`: e-auction objects out of the `armeps`
      folders, against **the deployed bucket** (ticket 14). Do not run `npm run reindex` against
      that bucket before this step.
- [ ] 3. `8c63323:migrations/add_tender_sources.js`: submission channel and source links
      (ticket 02).
- [ ] 4. `eb0a34b:migrations/add_unmatched_results.js` (ticket 03).
- [ ] 5. `d494592:migrations/add_evaluation_method.js` (ticket 05).
- [ ] 6. `68d5740:migrations/add_tender_cpv_codes.js`, then `npm run cpv:backfill` (dry run), then
      `npm run cpv:backfill -- --apply` (ticket 17). The backfill sends no alert.
- [ ] 7. `migrations/add_tender_document_text_hash.js` (ticket 24). It is **still on disk on
      purpose**: run it before the deploy, run it **again after** the deploy to fill invitations
      stored in between, and only then delete it (step 4 of CLAUDE.md's schema workflow).
- [ ] 8. `b5cd180:migrations/add_submission_address.js` (ticket 06).
- [ ] 9. `01563d9:migrations/add_tender_source_points_to.js`: `tender_sources.points_to`, filled for
      existing gnumner notices (ticket 07). Run it before the deploy and **again after**, like step 7:
      the old code writes notice links with the column blank, and the new code reads a paper
      invitation's notices only through it — a replay of a file whose notice is blank finds none
      and fails.

- [ ] 10. `migrations/add_listing_notices.js`: the `listing_notices` table and
      `unmatched_results.{procedure_type,was_public}` (ticket 31). **Still on disk**: delete it
      after this step has run on Neon (step 4 of CLAUDE.md's schema workflow). Then
      `npm run notices:backfill`, which fills the table from gnumner listing pages already in
      storage. Neon has none today, so it reports 0, but run it anyway: a page stored by a
      sweep under the old code is otherwise a notice the publicity check never sees.
- [ ] 11. `migrations/add_tender_source_failed_lots.js`: `tender_sources.failed_lots`, the lots
      a gnumner failed-procedure notice named (ticket 09). It has nothing to fill. **Still on
      disk**: delete it after this step has run on Neon (step 4 of CLAUDE.md's schema workflow).
      Run it before the deploy: the new code reads and writes the column on every candidate
      lookup, so ingestion fails without it.
- [ ] 12. `migrations/add_benchmark_discount_excluded.js`: `price_benchmarks.discount_excluded`,
      the awards a stored benchmark's discount left out because their contract is not the
      winning offer (ticket 10 follow-up). Nothing to fill: NULL reads "computed before the count
      was kept", and the nightly recompute writes it. **Still on disk**: delete it after this
      step has run on Neon (step 4 of CLAUDE.md's schema workflow). Run it before the deploy:
      the benchmark upsert writes the column, so a recompute fails without it.

Environment:

- [ ] Rename any `SOURCE_ARMEPS_*` variable to `SOURCE_EAUCTION_{BASE,CRON,REFRESH_CRON,DETAIL_BASE}`
      (ticket 01). An old name silently falls back to the defaults.
- [ ] `SOURCE_EAUCTION_BASE` is the **origin** (`https://eauction.armeps.am`), not the listing URL.
      Otherwise the pager never advances, and ticket 15's guard throws on page 2. Fix local `.env`
      too, if it is not already fixed.
- [ ] `AI_MODEL=anthropic/claude-opus-5` if the gateway is OpenRouter (ticket 16).
- [ ] The e-auction `rateLimit` value is decided: the 32/min edit in `sources.config.js` is
      committed or reverted.

After the deploy:

- [ ] `npm run scheduler`, so the new repeatable jobs (gnumner sweeps, ARMEPS refresh,
      `refresh-gnumner` paper close-out, `refresh-ppcm` ARMEPS results — ticket 10, no
      migration) are registered.
- [ ] Every gnumner invitation listing has a floor beside its watermark
      (`sweep:published:gnumner:{open,quotation}:floor`, ticket 31). Its first sweep is a cold
      start and writes it. A watermark with no floor (a sweep under older code) leaves the
      covered window empty: every competitive contract notice stays "unknown", which is safe
      but not useful. Delete that listing's watermark to force a cold start.
- [ ] One repeat sweep per source writes 0 rows and enqueues 0 jobs. A `normalize:replay` changes
      nothing.
- [ ] Neon checks the tickets left for deploy time:
  - checklists stored `unavailable` / `no_document` since `6f22fab` (tickets 16 and 22);
  - empty `ready` checklists (ticket 23's SQL);
  - rows stuck `pending` (ticket 20).

  Record the counts. They all re-run on their next generate.
- [ ] Delete `migrations/add_tender_document_text_hash.js` once step 7's second run is done, and
      commit.
- [ ] Add any migration from tickets finished after this list was written (08–13, 19). Check
      `git log --diff-filter=A -- 'migrations/add_*'` against this list.
