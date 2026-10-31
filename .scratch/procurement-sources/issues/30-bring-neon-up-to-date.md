# 30 — Bring Neon and the deployed environment up to date

**What to build:** The deployed database, bucket, Redis and environment variables reach the shape
the code now expects.

**Blocked by:** None.

**Status:** ready-for-human

**Decided 2026-10-30: Neon is recreated, not migrated.** It holds no data worth keeping. Every
additive script these tickets wrote (`add_*.js`) is deleted. `migrations/create_table.js` is the
whole schema.

That was checked on 2026-10-30: `create_table.js` was built into a scratch database and its
`pg_dump -s` diffed against local `tendra`, which had every add-script applied. All 170
statements are identical. The only difference is foreign-key names: Knex writes `_foreign`, and
the scripts got Postgres's `_fkey`. Nothing reads those names. `drop_table.js` leaves no table,
type or function, and `up` runs cleanly again after it.

The per-step list this ticket used to hold (renames, object moves, backfills, replays) only made
sense for a database with data. It is in git history (`git log -- .scratch/procurement-sources/
issues/30-bring-neon-up-to-date.md`) if a database with data ever needs it.

## Database (Neon)

- [ ] Point `PSQL_*` at Neon and check it twice. The same commands against local `tendra` drop it.
- [ ] `npm run migrate:down`, then `npm run migrate:up`.
- [ ] `npm run seed`. Plans are not self-seeding, and without them every organization reads
      `free` (`seed.js`).

## Redis (deployed)

- [ ] **Clear the sweep state:** `sweep:*`, meaning watermarks, floors, chain markers and
      `sweep:ok:*`. Also clear the old BullMQ repeatables and queues, or simply `FLUSHDB` if
      that Redis serves nothing else.
  - **This is not optional.** A watermark that survives into an empty database tells every
    sweep that it has already read everything above it, so the database never gets those
    tenders: a permanent, silent hole. With no watermark, each listing cold-starts and writes
    its floor (ticket 31 needs it).
  - Refresh-token families die with it. That is fine: every user is gone with the database.

## Bucket (deployed)

- [ ] **Empty the deployed bucket, or point the deployed `S3_*` at a new one** (recommended).
      Old objects do no harm while nothing reads them. But they include e-auction objects under
      the old `armeps` folders (ticket 14), and `npm run reindex` against a bucket that does not
      match its database is what ticket 14 warns about. A clean bucket removes the question.

## Environment

- [ ] Rename any `SOURCE_ARMEPS_*` variable to `SOURCE_EAUCTION_{BASE,CRON,REFRESH_CRON,DETAIL_BASE}`
      (ticket 01). An old name silently falls back to the defaults.
- [ ] `SOURCE_EAUCTION_BASE` is the **origin** (`https://eauction.armeps.am`), not the listing URL.
      Otherwise the pager never advances, and the chain's stall check throws on page 2. Fix
      local `.env` too, if it is not already fixed.
- [ ] `AI_MODEL=anthropic/claude-opus-5` if the gateway is OpenRouter (ticket 16).
- [x] The `rateLimit` edits in `sources.config.js` (e-auction 20 → 32, gnumner and armeps
      10 → 22) are committed or reverted. *(Committed 2026-11-01.)*

## After the code is deployed

- [ ] `npm run scheduler` registers every repeatable job: the sweeps, refreshes,
      `refresh-gnumner`, `refresh-ppcm`, `missed-ppcm` and `sweep-gnumner-eauction`.
  - **`missed-ppcm`'s first run is a 90-day ARMEPS backfill.** It finds a few hundred ARMEPS
    tenders and queues their document archives at the results priority, about 1.6–2.5 GB
    (ticket 12). Keep `missedSweep.windowDays` at 90 there, or decide otherwise first.
  - On a fresh database, every listing cold-starts and is bounded by `maxListingPages`, so the
    first day holds only the last few days of tenders. **History is the archive backfill**
    (`npm run backfill:start`), a separate decision.
- [ ] After the first sweeps: `npm run sources:verify`. Every gnumner e-auction notice should be
      held, and every listing should have a floor beside its watermark.
- [ ] One repeat sweep per source writes 0 rows and queues 0 jobs.
