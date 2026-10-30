# 38 — One listing chain per board at a time

**What to build:** A scheduled sweep does not start a new chain on a board while an earlier chain
on that board is still queued or running.

**Blocked by:** None.

**Status:** done

Found in ticket 34 (2026-10-30, local). The e-auction sweep fires every five minutes and starts a
new chain each time, even while older chains still sit in a slow `ingest.fetch` queue. Locally,
48 e-auction listing pages were queued at once.

Each chain is still correct: the watermark advances only when a chain ends. But every extra
chain re-reads the same pages, and it does so exactly when the queue is already behind. That is
the moment the rate budget is needed for detail pages.

## Acceptance

- [x] **A per-board in-flight marker in Redis**, set when a chain's first page is queued and
      cleared when the chain ends: it reached the watermark, it ran out of pages, or it threw. A
      sweep that finds the marker skips that board and logs it.
- [x] **A dead chain cannot block the board forever.** The marker has a TTL that every page of
      the chain refreshes. Choose the TTL from the queue's realistic worst case, and record the
      value. A crash then costs at most one TTL of no new chain, and the next sweep re-walks
      the gap as it does today.
- [x] **No source-name branch** in `listingChain.js`. Every board gets this rule.
- [x] **The freshness signal is untouched.** `sweep:ok:{source}` is still written on each
      successful page. A skipped sweep writes nothing, and must not look like a failure.
- [x] **Backfills are unaffected.** They walk their own page range and do not take this marker.
- [x] **Verify by hand, in process, with HTTP stubbed:**
  - a second sweep while a chain is queued queues nothing;
  - after the chain ends, the next sweep starts one;
  - a marker left by a killed chain expires after its TTL, and the sweep after that walks the
    gap.

## Done (2026-10-30)

- **The marker** is `{watermark key}:chain` (`sweepState.js#chainKey`, beside `#floorKey`),
  holding the chain's id. `sweepBoard` claims it `SET NX` before reading the watermark and
  queuing page 1, and the id rides down every page (`data.chain`). `readListingPage` re-arms it
  on every attempt and deletes it when the page ends the chain (watermark, no next page, page cap,
  304) or throws for the **last** time (`isFinalAttempt`, or `UnrecoverableError`). A throw BullMQ
  will retry, and a rate-limit `DelayedError`, are the same chain still going, so they keep it.
  A sweep that finds it logs `"<slug>" still has a chain queued or running` at info and returns
  `busy: [slug]`: no job, no freshness write, and no failure.
- **Only the holder may refresh or delete it** (Lua compare-and-set, like `withLock`). If a
  live chain outlives its TTL and a newer chain takes the marker, the older one runs to its end
  without releasing the newer one's marker. If nobody took it, the older chain takes it back.
- **TTL: 60 minutes**, from the local queue (2026-10-30). Listing pages waited p50 15 min, p95 34
  and max 49 for a worker, counting the time between queuing and the first attempt with the
  worker up. That is with ~48 stacked chains swelling the queue, which is the case this ticket
  removes. Longer waits (~12 h) were all retries queued overnight while the worker was down. The
  two failure modes are not symmetric. Too short brings back a duplicate chain, which is today's
  behaviour. Too long delays the next chain after one that vanished. A killed worker does not make
  a chain vanish, because BullMQ hands the active page on as stalled, so only a lost job or a stall
  past BullMQ's limit does.
- **No source branch:** the key derives from `board.watermarkKey(slug)`, so every board and every
  listing on its own `cron` gets the rule. **Backfills** (`workers/backfill.js`) do not use the
  chain and are untouched. Pages queued before the deploy carry no `chain` and touch no marker.

- **Per listing, which is what "per board" means here.** In code a board is a source's
  object with several listings (gnumner has six). The watermark and the chain are both per
  listing, so the marker is per listing too. A per-source marker would let gnumner's `open`
  chain block its `quotation` sweep.
- **Re-armed twice per page:** when the page starts, and again once it has queued the next one.
  So the TTL has to cover a page's wait for a worker and nothing else, which is what the
  measurement above is.

**Code review** (standards and spec, 2026-10-30) brought three changes:

- the watermark read moved inside the `try` that releases the marker, so a Redis error between
  the claim and the enqueue no longer holds the listing for an hour;
- the second re-arm above;
- "does this throw end the job" became `utils/attempts.js#endsJob`, shared with
  `documents.js`.

What the check does not cover: it calls the handler on jobs it builds or pulls itself, so
BullMQ's own retry and stall handling never ran. A page that stalls past BullMQ's limit fails
without the `catch` running, and the TTL is what frees the listing then. A page that queued its
next page and then stalled and re-ran queues that next page twice under one chain id (listing
pages carry no `jobId`). That duplicate was possible before this change too. When one copy
ends, it frees the listing while the other is still walking. Both cases are rare, and their
cost is a duplicate chain, which was already the behaviour before this change.

**Verified by hand**, in process, against Redis DB 9 (apart from the running worker's DB 0). A
stub board stood in for HTTP, with local storage and the handler called on each queued job.
21 checks passed:

```
PASS  first sweep queues page 1
PASS  marker set with TTL 3600 s
PASS  second sweep: busy, queues nothing, not a failure
PASS  skipped sweep wrote no freshness key
PASS  page 1 queues page 2 carrying the chain id
PASS  page 1 refreshed the marker TTL
PASS  a read page still writes sweep:ok
PASS  sweep while page 2 is queued queues nothing
PASS  chain read pages 1,2,3,4 and released the marker on its last page
PASS  watermark committed at 110
PASS  next sweep starts a chain from watermark 110
PASS  that chain reached the watermark: 113, marker released
PASS  killed chain: the sweep after it is blocked by the marker
PASS  blocked only for the marker TTL (~60 min) — simulating its lapse
PASS  after expiry the sweep starts a chain from the old watermark 113
PASS  it re-walked the gap (114..116) in 2 pages, watermark 116
PASS  a throw BullMQ will retry keeps the marker
PASS  a rate-limit delay keeps the marker
PASS  a throw on the final attempt releases it
PASS  an older chain's end does not release the newer chain's marker
PASS  a page with no chain id sets no marker
```

The expiry was simulated by shortening the live marker's TTL (`PEXPIRE`) after checking it
was ~3600 s, not by waiting an hour.

**Seen while measuring, not fixed here:** the overlapping e-auction chains of 2026-10-29 failed
with `page N holds tids up to …, newer than page N−1's oldest — pager did not advance`. A
board that gains notices while a chain waits 15–30 min between pages shifts older rows down
onto the next page. So the stall check can fire on a pager that did advance, and a board that
*loses* rows (an amended e-auction leaves the listing) can move one up past a page already
read. One chain at a time shortens the waits, but that does not remove the problem.
