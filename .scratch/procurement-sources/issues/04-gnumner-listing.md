# 04 — gnumner listing: discover ARMEPS and paper tenders

**What to build:** Tendra sweeps gnumner's announcement listings, the index of every channel, and
sorts each item into an ARMEPS discovery (a link to an armeps.am `resourceId`), a paper discovery
(an uploaded file) or an e-auction notice (counted only). Nothing reaches `tenders` yet, because
the listing writes no domain rows. The work is verified by its counts. Spec: *Sources and parsers →
gnumner*. Research: *Paper share, measured on gnumner announcements*.

**Blocked by:** 01

**Status:** done

- [x] A `gnumner` adapter folder with a client and a pure listing parser. TLS goes through the
      existing extra CA in `certs/`, never `rejectUnauthorized: false`.
- [x] The parser reads the open-tender and quotation announcement listings (other procedure
      types' listings are handled when they share the shape). Each item yields title, publish
      datetime, link target and the procedure code found in the title, if any.
- [x] Classification: armeps.am `resourceId` link → ARMEPS; file under `/website/images/` →
      paper; eauction `tmid` link → counted for coverage and otherwise skipped.
- [x] Non-public buyers (Electric Networks of Armenia's own requests, project implementation
      units) are excluded by a configured list, not by guessing.
- [x] Depth is a per-listing watermark on the newest stored publish datetime. It advances only
      when a chain terminates. `maxListingPages` is the cold-start bound only, and the reported
      page total is never trusted.
- [x] Raw listing HTML goes to storage and `source_payloads`. A repeat sweep writes 0 rows and
      enqueues 0 jobs.
- [x] Zero items on a 200 throws. Rate limiting defers, never burns an attempt. The declared bot
      UA is used, and limits are no looser than eauction's.
- [x] ARMEPS discoveries enqueue a detail fetch keyed by `resourceId`, which ticket 05 consumes.
      Paper discoveries enqueue an invitation fetch, which ticket 06 consumes. Until those land,
      the jobs are recorded, not lost.
- [x] New job names are constants. The scheduler registers the sweep with an id derived from the
      source key, and freshness is written to `sweep:ok:gnumner`.
- [x] Verified by hand: one sweep of page 1 reports counts per classification that match the page
      read in a browser. Record them here.

## Verification (2026-10-19, local Redis + Postgres `tendra`, live gnumner)

Run in-process (the handlers called directly, not a Worker, because `ingest.fetch` holds an
unrelated 1,534-job e-auction document backlog). Every request went through the `gnumner` rate
limiter: 10 requests a minute, half of eauction's 20. No request was throttled.

**Page 1, sweep result vs the page itself.** The "page" column was counted with grep over the raw
HTML the sweep stored (`raw/gnumner/listing%3A<slug>%3Ap1/…`), not with the parser. It is the same
HTML a browser renders, and its hash was byte-identical across two fetches 15 minutes apart.

| Listing | Blocks | ARMEPS | Paper | Excluded | e-auction | Duplicate |
|---|---|---|---|---|---|---|
| quotation, sweep | 10 | 3 | 6 | 0 | 0 | 1 |
| quotation, page | 10 | 4 links, 3 distinct | 6 files | 0 | 0 | the 4th ARMEPS link |
| open, sweep | 10 | 7 | 1 | 1 | 0 | 1 |
| open, page | 10 | 8 links, 7 distinct | 2 files | 1 «Հայաստանի էլեկտրական ցանցեր» | 0 | the 8th ARMEPS link |

"Duplicate" means the same ARMEPS link listed twice in a row with an identical title and time. It is
counted and ingested once.

**Cold start, then repeat.**

- Cold start, with no watermark: 5 pages of each listing (the `maxListingPages` bound). It wrote 85
  `source_payloads` rows (10 pages + 75 notices) and enqueued 75 discovery jobs (`armeps.detail` +
  `paper.invitation`). Excluded over the 5 open-tender pages: 9 (8 «Հայաստանի էլեկտրական ցանցեր», 1
  World Bank loan, «Վարկ No. 9338-ԱՄ»). Watermarks were set to the newest publish datetime on each
  page 1: open `2026-10-19T13:14:00Z`, quotation `2026-10-19T16:30:16Z`.
- Repeat sweep: both chains stopped on page 1 ("reached the watermark"). It wrote **0 rows** and
  enqueued **0 jobs**. `sweep:ok:gnumner` was written.

**Sort order, which the watermark rests on:** across the 5 stored cold-start pages, publish
datetimes never increase: 0 order breaks in 44 open-tender items (back to `2026-10-14T06:32Z`) and
in 43 quotation items (back to `2026-10-19T06:51Z`).

**Not exercised live:** neither listing carried an e-auction `tmid` link on these pages, so that
branch was checked only with `classify()` on a constructed URL. Rate-limit deferral was not
triggered either. It uses the same `moveToDelayed` + `DelayedError` path as eauction.

**Left for 05 and 06:** the 75 discovery jobs sit in `ingest.fetch` (prioritized). A worker parks
them for 6 hours at a time, without spending an attempt, until their handlers replace
`parkUntilConsumerExists`. Parked jobs count toward the health check's backlog
(`MONITOR_BACKLOG_ALERT` 5,000). At about 40 discoveries a day that becomes an issue only after
months.
