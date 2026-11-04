# 15 — One listing chain for every board; e-auction stops skipping gaps

**What to build:** Every listing board (e-auction today, and the four gnumner listings by ticket 09)
is swept by one shared listing-chain module. Each source supplies only what differs: how a page is
read, what the watermark is (tid or publish datetime), and which job a notice becomes. Fixing it
once also fixes e-auction's chain, which today **silently skips unread pages after an outage**.

**Blocked by:** 04

**Status:** done

Found while reviewing ticket 04. `handleGnumnerListingPage` and eauction's `handleListingPage` are
near copies: fetch with rate-limit deferral, the zero-blocks guard, storing the page payload, the
enqueue-before-record notice loop and watermark continuation. Where they differ, gnumner is the one
that follows CLAUDE.md:

- **e-auction caps every chain at `maxListingPages` (40), watermark or not.** After an outage longer
  than 40 pages, the chain stops at page 40 and commits the high watermark over a gap it never
  read. That is a permanent, silent coverage hole, exactly the missed tender this design exists to
  prevent. CLAUDE.md says `maxListingPages` is the cold-start bound only. gnumner applies it that
  way: with a watermark it walks to the global ceiling, and it warns when a chain ends without
  reaching the watermark.
- e-auction trusts the site's reported last page. gnumner trusts only whether a next page exists.

Acceptance criteria:

- [x] A shared listing-chain module owns:
  - fetch with `RateLimitedError` → `moveToDelayed` + `DelayedError`;
  - 304 handling (eauction);
  - zero blocks on 200 → throw;
  - page payload storage;
  - the per-notice `existsWithHash` → enqueue → record loop, enqueuing **before** recording;
  - `markSweepHealthy`;
  - continuation and watermark commit.
- [x] Each source plugs in its page reader, watermark value per notice, watermark key, and notice →
      `{ ref, hash, job }` mapping, plus any per-notice skip, such as gnumner's coverage counts and
      excluded buyers. No branching on source names inside the shared module.
- [x] One cap rule for all sources: `maxListingPages` applies only to a cold start (no watermark).
      With a watermark the chain walks until it reaches it, bounded only by the global
      `SCRAPER.MAX_LISTING_PAGES`. A chain that ends without reaching the watermark logs a warning
      naming how far it got.
- [x] Whether to continue depends on a next page existing, not on the site's reported page total,
      for every source. If e-auction's pager can't answer "is there a next page" any other way, say
      so here and keep its page total only as that answer.
- [x] e-auction behaviour is otherwise unchanged: a live sweep over known tenders writes 0 rows and
      enqueues 0 jobs, and its log lines still carry blocks, usable rows, changed rows and the
      stop reason.
- [x] gnumner behaviour is unchanged: re-run ticket 04's page-1 counts and repeat sweep, with the
      same numbers.
- [x] The outage case is checked by hand on e-auction: set its watermark far enough back that the
      gap exceeds `maxListingPages`, sweep, and confirm the chain passes page 40 and commits only
      after reaching the old watermark. Record it here. Use a throwaway Redis DB, or restore the
      watermark afterwards.
- [x] CLAUDE.md's ingestion section describes the one rule, and docs/SCRAPER_WORKFLOW.md too if it
      describes the old cap.

## Verification (2026-10-19, local Postgres `tendra`, throwaway Redis DB 15, live sources)

The DB 0 worker was stopped throughout. Each sweep ran in-process against Redis DB 15 with a
BullMQ worker that ran only `source.sweep` and `listing.page`. Every other job a sweep produced
(`tender.detail`, `armeps.detail`, `paper.invitation`) was forwarded to the real DB 0 queue with its
job id, so no notice recorded in `source_payloads` is missing its job. DB 15 was flushed afterwards.
No DB 0 watermark was touched. DB 0 had no `sweep:tid:eauction:*` key before this ran and still has
none.

**Found while verifying: the local e-auction pager has never advanced.** Ticket 01 noted that the
local `SOURCE_EAUCTION_BASE` is the listing URL (`…/hy/public/tender/`) rather than the origin,
but nobody worked out what that does. `listingUrl` builds
`https://eauction.armeps.am/hy/public/tender//hy/public/tender/start/N`, and the site answers that
malformed URL with **page 1 for every N**. So every local e-auction chain, before and after this
ticket, has re-read page 1 down to its cap. The stored `listing:all-tenders:p2…p159` payloads
written today are page 1's HTML (2 distinct hashes across 158 rows). `backfill.js` builds its URLs
the same way. **Fix `.env`:** `SOURCE_EAUCTION_BASE=https://eauction.armeps.am`, or remove the line
so the default applies. It was not changed here. The verification runs below override it for their
own process only.

Lifting the 40-page cap makes that failure more expensive: a chain with a watermark would re-read
page 1 up to `SCRAPER.MAX_LISTING_PAGES` (200) every sweep. A first, interrupted outage run did
exactly that, reaching page 159 before the machine rebooted. So `nextStep` now refuses a page
holding a mark newer than the previous page's oldest. The chain throws before it stores, enqueues
or marks anything healthy, and the watermark is not committed. Ties are allowed, because gnumner's
publish times are minute-precision and can straddle a page break. This guard does not depend on
the source: every board is newest-first. The first version tested `pageLow >= prevLow` and ran
after `markSweepHealthy`; review caught both problems. Page 1 of a stalled chain still writes
`sweep:ok`, because page 1 really was read. The failure shows up as dead-lettered page-2 jobs,
not as staleness.

**Pager guard, live (old `.env` base kept):** watermark 46800. Page 1 read tids 48181..48214. Page 2
threw `page 2 holds tids up to 48214, newer than page 1's oldest 48181 — pager did not advance` on
every attempt (5 on the first run, re-checked on the final code) and went to `failed`. The watermark stayed at 46800. 0 rows written.

**Outage case, e-auction (correct base):** watermark set to 46800, 1,414 tids below the top
(48214). `maxListingPages` is 40.

| page | tids | new/changed | decision |
|---|---|---|---|
| 1 | 48181..48214 | 0 | continue |
| 38 | 46878.. | 0 | continue |
| 39 | 46841.. | 0 | continue |
| 40 | 46803.. | 8 | **continuing to page 41** (the old code stopped here: `page cap 40`) |
| 41 | 46767.. | 30 | stopping (reached the watermark) |

The watermark was committed only by page 41: 46800 → 48214. No warning. 41 pages, 166 notices
new/changed, 207 `source_payloads` rows (41 pages + 166 notices), 166 `tender.detail` jobs (now
waiting in DB 0). The 38 notices on pages 40–41 are exactly what the old cap would have skipped
for good.

Re-run on the final code after review, from the same 46800 watermark: again 41 pages,
`continuing to page 41` at page 40, `stopping (reached the watermark)` at page 41, and 48214
committed with no warning. This time 3 notices were new or changed (status moves in the intervening
20 minutes), 3 `tender.detail` jobs were forwarded, and 18 rows were written (15 new page variants
plus 3 notices).

**Repeat sweep, e-auction:** page 1, `stopping (reached the watermark)`. **0 rows, 0 jobs.** The
log line still carries blocks, usable rows, changed rows and the stop reason.

**Stopping short of the watermark (`SCRAPER_MAX_LISTING_PAGES=3`, watermark 46800):** stopped at
`page cap 3` and warned `chain ended at page 3 (page cap 3) without reaching the watermark 46800;
oldest read 48115 — older notices were not read`.

**gnumner, same numbers as ticket 04.** The repeat sweep (DB 0 watermarks copied in) was run with
the old code first, then the new code, minutes apart:

| Listing | Blocks | ARMEPS | Paper | e-auction | Excluded | Duplicate | Rows / jobs |
|---|---|---|---|---|---|---|---|
| open, old code | 10 | 7 | 1 | 0 | 1 | 1 | 0 / 0 |
| open, new code | 10 | 7 | 1 | 0 | 1 | 1 | 0 / 0 |
| quotation, old code | 10 | 3 | 6 | 0 | 0 | 1 | 0 / 0 |
| quotation, new code | 10 | 3 | 6 | 0 | 0 | 1 | 0 / 0 |

The new-code row was re-run on the final code after review, with the same numbers. These are also
ticket 04's page-1 numbers. A cold start with no watermark walked 5 pages of each
listing and stopped on `page cap 5`. The oldest open item was `2026-10-14T06:32Z` and the oldest
quotation item `2026-10-19T06:51Z`, as in ticket 04. The watermarks it set equal DB 0's (open
`13:14:00Z`, quotation `16:30:16Z`). It wrote 0 rows and enqueued 0 jobs, since everything was
already recorded.

**e-auction's "is there a next page":** the pager's `→` arrow (`a.pg_b`). Its href is not used,
because page 1's is malformed (`…/tender/hy/public/start/2`). The arrow overstates the tail:
pages 1016 and 1017 (of a reported 1017) are empty and still carry it, and only 1018 drops it.
Only a chain walking the whole archive would reach that, and it would then throw on zero blocks.
`pagination.lastPage` stays, but only for `backfill.js`'s page range.

**Pure rule:** `nextStep` was checked with assertions in a scratch script (cold cap, watermark
cap, global ceiling, no next page, pages with no marks, stall). No test runner exists. The repo's
first test would be a natural home for these.

**Left in flight:** the 37 `listing.page` jobs in DB 0 that carry the legacy `sinceTid`/`highTid`
are read through a compatibility fallback in `readListingPage`. They are cold-start chains
(`sinceTid: 0`). While `.env` keeps the listing-URL base, each one throws at its second page under
the new guard, which is the intended loud failure. Drop the fallback once they have drained.
