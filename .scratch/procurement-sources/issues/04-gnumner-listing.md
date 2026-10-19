# 04 — gnumner listing: discover ARMEPS and paper tenders

**What to build:** Tendra sweeps gnumner's announcement listings, the index of every channel, and
sorts each item into an ARMEPS discovery (a link to an armeps.am `resourceId`), a paper discovery
(an uploaded file) or an e-auction notice (counted only). Nothing reaches `tenders` yet, because
the listing writes no domain rows. The work is verified by its counts. Spec: *Sources and parsers →
gnumner*. Research: *Paper share, measured on gnumner announcements*.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] A `gnumner` adapter folder with a client and a pure listing parser. TLS goes through the
      existing extra CA in `certs/`, never `rejectUnauthorized: false`.
- [ ] The parser reads the open-tender and quotation announcement listings (other procedure
      types' listings are handled when they share the shape). Each item yields title, publish
      datetime, link target and the procedure code found in the title, if any.
- [ ] Classification: armeps.am `resourceId` link → ARMEPS; file under `/website/images/` →
      paper; eauction `tmid` link → counted for coverage and otherwise skipped.
- [ ] Non-public buyers (Electric Networks of Armenia's own requests, project implementation
      units) are excluded by a configured list, not by guessing.
- [ ] Depth is a per-listing watermark on the newest stored publish datetime. It advances only
      when a chain terminates. `maxListingPages` is the cold-start bound only, and the reported
      page total is never trusted.
- [ ] Raw listing HTML goes to storage and `source_payloads`. A repeat sweep writes 0 rows and
      enqueues 0 jobs.
- [ ] Zero items on a 200 throws. Rate limiting defers, never burns an attempt. The declared bot
      UA is used, and limits are no looser than eauction's.
- [ ] ARMEPS discoveries enqueue a detail fetch keyed by `resourceId`, which ticket 05 consumes.
      Paper discoveries enqueue an invitation fetch, which ticket 06 consumes. Until those land,
      the jobs are recorded, not lost.
- [ ] New job names are constants. The scheduler registers the sweep with an id derived from the
      source key, and freshness is written to `sweep:ok:gnumner`.
- [ ] Verified by hand: one sweep of page 1 reports counts per classification that match the page
      read in a browser. Record them here.
