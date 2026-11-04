# 39 — Listing rows that shift while a chain walks

**What to build:** A listing chain reads every notice of a board even when the board gains or
loses rows while the chain is between pages. A pager that really did not advance is still caught.

**Blocked by:** None.

**Status:** done

Found in ticket 38 (2026-10-30, local). Many of 2026-10-29's e-auction chains failed with `page N
holds tids up to …, newer than page N−1's oldest — pager did not advance`. The pager had
advanced. A chain waits 15–30 minutes between pages, because its next page is queued at
`PRIORITY.LIVE`, the same as every detail and refresh job, and in the meantime:

- **The board gains rows.** New notices push older ones down, so page N repeats the tail of page
  N−1. The stall check throws, the chain dies, and its watermark never commits, so the next
  chain re-walks everything. That wastes requests, and it is not a correctness failure.
- **The board loses rows.** An amended e-auction leaves the listing (ticket 29), and older rows
  move up. The first row of page N+1 lands on page N, which was already read, and is skipped.
  Its mark is below the watermark the chain commits, so no later chain reads it either. **That is
  a permanent, silent miss.** Ticket 34's coverage check would be the only thing to see it.

Every board shares the chain, so gnumner's listings have the same exposure.

## Acceptance

- [ ] **A chain finishes in seconds, not half an hour.** *(Built and checked on a scratch queue; the
      "after" timing waits on a worker restart — see Done.)* A chain's next page is queued ahead of
      every detail, document and refresh job. That means a priority strictly above anything
      else on `ingest.fetch`, or a queue of its own; choose one and say why. Check how BullMQ
      orders prioritized jobs against jobs with no priority before relying on it. Measure page
      1 → last page on the local backlog, before and after.
- [x] **Overlap is not a stall.** Rows on page N whose mark is at or above page N−1's oldest are
      the shift from new rows. They were already read, so skip them. Throw only when page N
      holds no row below page N−1's oldest: the same page came back, or the base URL bug from
      CLAUDE.md. Ties are still legal.
- [x] **A row lost to a shift upward is found.** Choose a mechanism and record why it is
      enough. For example, each next page re-reads with one page of overlap, or a chain that
      saw page sizes change re-walks its range once before committing. If nothing cheap is
      enough, record the residual risk with numbers: how often an e-auction leaves the
      listing, against the chain's run time once the first box is done.
- [x] **No source-name branch** in `listingChain.js`.
- [x] **Verify by hand, in process, with a fake board that changes between pages:**
  - rows inserted at the top mid-chain: no throw, every row read once;
  - a row removed mid-chain: the shifted row is still read;
  - the same page served twice: it still throws.
- [ ] **Count the chains that died with "pager did not advance"**, from the local logs before
      the fix, and again after a day of the worker running the fix.
      *(Before: 43. After: open until the worker has run the fix for a day.)*

## Done (2026-10-30)

**Priority, not a queue.** `PRIORITY.CHAIN = 1`, and `LIVE` moves to 2 (`RESULTS` 5 and
`BACKFILL` 10 are unchanged). Every page after a chain's first goes at `CHAIN`. Page 1 keeps
its listing's priority, which decides when a chain *starts*. BullMQ 6 drains the plain wait
list (no priority) before any prioritized job (`moveToActive-11.lua`: `RPOPLPUSH wait`, then
`ZPOPMIN prioritized`; documented on `JobsOptions.priority`). Within the prioritized set, the
lower number goes first, FIFO on ties. Checked on a scratch queue in local Redis: no priority →
`listing.page@CHAIN` → 40 `tender.detail@LIVE` → `tender.documents@BACKFILL`.
- **Why not the wait list.** `names.js` records it once starving the document stage. Today it
  holds only the scheduler's dispatchers (sweep, refresh, ppcm sweep), which make no request.
- **Why not a queue of its own.** The rate budget is per source either way, so a second queue
  would add a worker and more concurrency pointed at the source, not throughput.
- **Transient after deploy.** Jobs already queued at 1 (121 `tender.detail` locally at
  12:35) tie with `CHAIN` until they drain, about 4 minutes at 32 requests/min. So do jobs
  that copy their parent's priority (`armeps.js`, `scraper.js`, `paper.js`) for a hop or two.
  Accepted rather than re-prioritized by hand.

**Overlap.** A page job carries `low` (the oldest mark read so far) and `lowKeys` (the board
keys of the entries read at `low`). Each board has a new `keyOf`: the tid on e-auction, and
`kind:externalId` on gnumner (the parser's own dedupe identity).
- An entry newer than `low`, or at `low` and named in `lowKeys`, was already read and is
  skipped (`isRead`). Ties need the keys: gnumner's publish minutes straddle page breaks. The
  most seen in one minute is 2 (`listing_notices`), but a page of ties at `low` is not a
  stall.
- The chain throws only when the page holds no unread entry with a usable mark. That catches
  the same page served again and the base-URL bug, and it throws before the re-read, any store
  or a health mark.

**Lost row.** Every page after the first re-reads the previous page *after* reading its own.
- A row pulled up before this page's request is on the re-read. One pulled up after it was on
  this page, and `onThisPage` keeps it from being read twice. One pulled up from N+1 during
  the job is on job N+1's re-read of N.
- That covers any one insertion or removal at any moment of the chain. The other order (re-read
  N−1, then read N) loses a row leaving between the two requests.
- **Cost.** One request per page after the first. The local steady state since ticket 38 is a
  1-page chain, which pays nothing. A throttle on the second request fetches both again.
- **Residual risk, with numbers.** Not covered:
  - a removal in the gap before a page's request, then an insertion between that job's two
    requests (the row moves up and back down unseen);
  - a page's worth of rows moving at once.

  On 2026-10-29, 21 e-auctions left the listing (superseded links) against 332 new tids. With
  a gap of ~5 s and ~1 s between a job's two requests, the first case is
  (21/86 400 × 5) × (332/86 400 × 1) ≈ 5×10⁻⁶ per page, about 5×10⁻⁵ for a 10-page catch-up
  chain, and 0 for a 1-page chain.

**Verified by hand.** Harness:
`node --experimental-test-module-mocks harness.mjs` (scratchpad, `mock.module` over the queue,
Redis state, payload repo and storage). Fake board: 30 rows, page size 5, watermark 5 pages down.

| scenario | before (63c3291) | after |
|---|---|---|
| quiet board | ok | ok (11 requests instead of 6) |
| 3 rows inserted before page 3 (2 more before page 5) | **throws** "pager did not advance", watermark not committed | ok, every row read once |
| row on page 1 removed before page 3 | **r120 missed**, watermark committed over it | ok, found on the page-2 re-read |
| row removed between page 3 and the page-2 re-read | **r115 missed** | ok |
| 2 rows inserted between page 3 and the page-2 re-read | **throws** | ok |
| row removed before the last page | ok | ok, found on the re-read |
| tie straddling a page break (± an insertion) | ok | ok, read once |
| a whole page tied at the previous page's oldest mark | — | ok |
| same page served twice | throws | throws (2 requests, nothing stored) |

**Chains that died with "pager did not advance"** (`logs/combined.log`, which starts on
2026-10-30 for this worker):
- **Before:** 43 e-auction chains on 2026-10-30, up to 12:33. That is 215 failed attempts,
  5 per chain, and 0 on gnumner.
- **After:** open. The local worker (started 12:29) runs the old code until it is restarted.

**Page 1 → last page.**
- **Before:** page waits of p50 15 min, p95 34 and max 49 at `LIVE`, measured for ticket 38
  with ~48 stacked chains. At 12:35, with chains one at a time, a `LIVE` page still queued
  behind 121 details (~4 min a page at 32 requests/min).
- **After:** open. A `CHAIN` page waits only for the active jobs and the rate limiter, so a
  page should take seconds. Measure on the first multi-page chain after the restart, once the
  priority-1 backlog has drained.

