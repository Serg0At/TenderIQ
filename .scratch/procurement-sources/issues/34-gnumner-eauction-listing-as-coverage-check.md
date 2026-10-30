# 34 — Sweep gnumner's e-auction listing as an independent coverage check

**What to build:** gnumner's e-auction announcement listing is swept and its notices are indexed in
`listing_notices`, so that `sources:verify` can count gnumner's e-auction notices against the
e-auction tenders Tendra holds (spec story 32). Today that count reads 0. The notices sit on their
own listing, which is not in `listingPaths`. Found in ticket 13.

**Blocked by:** None.

**Status:** done

Decided 2026-10-28. This is the only check on the e-auction sweep that does not come from
eauction.armeps.am itself. The tid chain is complete only by its own account. A board the site
stops showing, or a filter the site adds, would be invisible from inside, and missed tenders are
the #1 churn cause (NFR-DATA-2).

## Acceptance

- [x] **One more board on the shared listing chain** (`workers/listingChain.js`, through config).
      The chain gets no source-name branch.
- [x] **Discovery only, and counted:** each notice is written to `listing_notices` with its tid
      (`eauction:` id, from the `tmid` link). It queues no detail job and creates no tender.
      eauction.armeps.am stays the only source of an e-auction tender. A notice with no
      readable tid is still indexed, and counted as *no code* by the verify script.
- [x] **Its own cadence, slower than the invitation listings.** Nothing waits on this board, and
      the chain walks to the watermark however rarely it runs. Make it a knob in
      `sources.config.js` (hourly is enough), so it costs well under ticket 13's estimate of 24
      requests an hour. It shares gnumner's rate budget, behind live discovery.
- [x] **Cold start:** bound it by `maxListingPages`, as every board is, with the floor written
      beside the watermark like the other gnumner listings.
- [x] **Run `npm run sources:verify`.** Paste its e-auction-notices block here: held, not held,
      and no code. For each one not held, check by hand whether the tid really is missing from
      Tendra, or is a superseded run, a page outside the window, or similar. Record what you find.
- [x] Register it through `npm run scheduler`, and add that to ticket 30's list.

## Built (2026-10-30)

- **The listing** is «Էլեկտրոնային աճուրդի հայտարարություն և հրավեր»,
  `/hy/page/elektronayin_achurdi_haytararutyun_ev_hraver/`, slug `eauction`, `kind: 'eauction'`
  in `sources.config.js`. Every link on it is an e-auction's `tmid` page (50 of 50).
- **The board.** It is one more entry in gnumner's `listingPaths`, on the shared chain:
  - A listing may carry a `cron` of its own, and a `priority` (a `PRIORITY` key). This one is
    `23 * * * *` (`SOURCE_GNUMNER_EAUCTION_CRON`) at `RESULTS`.
  - The scheduler registers `sweep-gnumner-eauction` with `data.slug`.
  - `listingChain.js#listingsToSweep` keeps a listing with a `cron` out of the five-minute
    sweep, and a sweep that names a slug reads only that listing, under its own lock. None of
    this branches on a source name.
- **Discovery only.** `gnumner.js#noticeIndex` indexes the e-auction listing beside the
  invitation listings. `toNotice` returns no notice for anything on it, so it queues no job.
  A link there that is not an e-auction's is counted `other`, with a warning.
- **No tid.** A gnumner notice names an e-auction by its `tmid`, never its tid. The index id
  is `listing:eauction:eauction:{tmid}`, not the `eauction:{tmid}` an invitation listing gives
  the same link: a `listing_notices` row is one per `(source, external_id)` and keeps the
  listing that wrote it first, so a shared id would count for whichever sweep reached it first
  (found in review).
  - Correction to research.md: the tmid page is no longer an empty shell. On 2026-10-30 it
    stated the code, title, buyer, publication time and deadline, but still no tid.
  - Reading it would put a code on every notice, at one eauction request each. That was not
    done: the board is discovery only.
- **The count holds a code-less notice by its publication second** (`sourceVerification.repo.js
  #eauctionNoticeCoverage`). 36 of the 50 titles name no code, so "no code, cannot be checked"
  would have left the check blind to 7 in 10.
  - gnumner states an e-auction's publication to the second, as eauction's own page does.
  - All 8 code-less notices of 2026-10-29 13:19–19:13 UTC matched one e-auction tender's
    `published_at` exactly, and its deadline matched too.
  - The time match is only for a notice with no code. A coded notice is held by its code.
  - It fails toward "not held": a second's code-less notices are held only while that second
    holds at least as many e-auction tenders as the listing has notices, so two notices cannot
    lean on one tender (found in review). The deadline is not compared: `listing_notices`
    does not store the listing's close.
  - **Beyond the letter of the ticket**, which asked for code-less notices to be counted as
    *no code*. They still are counted (`with no code`), and each one the time match does not
    hold is listed as not held.
- **Not a publicity fact.** `listingNotice.repo.js#publicityFacts` now reads only the listings
  it is given, and the argument is required.
  - The e-auction listing's code-less titles would put an "uncoded notice nearby" in every
    span: checked, 2026-10-28 → 10-30 reads `uncodedNearby: true` from that listing alone.
    That would turn every covered-window `false` into "unknown".
  - Its codes would make e-auction PPCM rows `was_public` true, against the standing decision
    that e-auction misses are not counted until the operator alert chooses its rule.
  - An empty default would make `codeSeen` false, and a false creates result-only tenders.
  - Existing rows are all `open`/`quotation`, so nothing resolved so far changes.
- **Cold start, run in-process on local** (the queue's `add` replaced by a recorder and fed
  back to `readListingPage`, so the stale local worker never saw a job):
  - 5 pages, 10 e-auction notices each, stopped at `page cap 5`, 0 jobs queued.
  - The watermark `sweep:published:gnumner:eauction` is 2026-10-30T05:34:00Z, and the floor
    beside it is 2026-10-28T11:57:39Z.
  - 5 `listing:eauction:p{1..5}` payloads were stored, and 50 `listing_notices` rows written
    (14 coded).
  - A repeat sweep made 1 request, `reached the watermark`, and wrote 0 rows.
  - `notices:backfill` re-read the stored pages and left the row count unchanged at 202.
  - Volume is about 30 a day (50 over 41.6 hours), so an hourly run costs 1–2 requests against
    ticket 13's 24.

### `npm run sources:verify` (2026-10-30, local)

```
— gnumner e-auction notices against e-auction tenders held —
  50 notices: 48 held, 2 not held
  with a code in the title:  12 of 14 held by code
  with no code (by publication second): 36 of 36 held
  not held: eauction:15370cf6-a061-4456-b6ac-d018ecdb5208 ԿՄՀՔ-ԷԱՃԱՊՁԲ-26/104 published 2026-10-30T05:27:27.000Z
  not held: eauction:911dd6f5-718b-4eda-9a39-379f1065f6e7 ԵՔ-ԷԱՃԱՊՁԲ-26/391 published 2026-10-30T05:34:00.000Z
```

Both checked by hand. **Neither is missing from the e-auction sweep; both are queued:**

- They are tids 48533 and 48512. Both are on eauction's own listing page 1 as stored at
  07:23Z and 07:25Z, and both have their `notice:` fingerprint rows (07:23Z).
- Their `tender.detail` jobs are `prioritized` behind a local backlog of 668 `ingest.fetch`
  jobs: 502 document downloads, 120 refresh details and 48 e-auction listing pages.
- The local tid watermark is still 48190, because no chain has terminated to commit a newer
  one.

### Numbers for the operator alert's N (out of scope here)

- gnumner listed these two at 05:27Z and 05:34Z. eauction's listing showed them by 07:23Z, the
  first local sweep that reached them. At 07:30Z neither was a tender yet.
- That lag is the local backlog, not the source: the 36 code-less notices of the previous day
  were all held. Take N from production, where the queue is not backed up. A notice is only
  worth paging on once the e-auction sweep has had a full chain and its detail jobs have run,
  so N should exceed the worst normal queue delay rather than the five-minute sweep cadence.

### Review (2026-10-30)

Fixed:

- The per-listing index id (above).
- The time match no longer lets several notices lean on one tender (above).
- The scheduler removes a `sweep-{source}-{slug}` schedule whose listing lost its `cron` or
  left the config (checked with a planted `sweep-gnumner-old`). Otherwise it would sweep beside
  the source's sweep under another lock, or throw on every firing.
- A `priority` that is not a `PRIORITY` key throws `UnrecoverableError`, rather than quietly
  becoming live (checked with `'RESULT'`).
- `migrations/create_table.js` names the e-auction listing in `listing_notices`' comment.

The local rows were rebuilt for the new id: the 50 old rows were deleted, then
`notices:backfill` was run. The verify block is unchanged, apart from the ids. A repeat sweep
wrote 0 rows (202 in all).

Left as is: the e-auction listing's pages refresh `sweep:ok:gnumner`, as the amendment,
contract and failure listings already do. Freshness is per source, not per listing.

### For the owner

- **The local e-auction sweep runs overlapping chains.** 48 queued listing pages include
  several page 1s and page 2s at once: each five-minute sweep starts a new chain from the same
  uncommitted watermark while older ones are still walking behind the backlog. It is correct
  (the high mark is committed only at a chain's end), but it multiplies listing requests while
  the queue is slow. Not changed here; worth a look if production shows the same.
- **The scheduler was not run against local Redis.** Only `sweep-eauction` and
  `refresh-eauction` are registered there. `npm run scheduler` would also start `missed-ppcm`,
  whose first run is the 90-day ARMEPS backfill you asked to approve first. The registration
  was checked with the upserts recorded instead of written: `sweep-gnumner-eauction`,
  `23 * * * *`, `{ source: 'gnumner', slug: 'eauction' }`. It is on ticket 30's list.
- **The running local worker predates this change.** Restart it before the hourly schedule
  exists locally: the old `sweepBoard` ignores `slug`, and would answer it with a full gnumner
  sweep.

## Out of scope

- **The operator alert reading "a gnumner e-auction notice whose tid Tendra lacks after N
  hours"** as the e-auction miss signal. That belongs to the alert's own design. Note the
  numbers here so that design has them.
