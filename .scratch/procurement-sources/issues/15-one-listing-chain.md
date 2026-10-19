# 15 — One listing chain for every board; e-auction stops skipping gaps

**What to build:** Every listing board (e-auction today, and the four gnumner listings by ticket 09)
is swept by one shared listing-chain module. Each source supplies only what differs: how a page is
read, what the watermark is (tid or publish datetime), and which job a notice becomes. Fixing it
once also fixes e-auction's chain, which today **silently skips unread pages after an outage**.

**Blocked by:** 04

**Status:** ready-for-agent

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

- [ ] A shared listing-chain module owns:
  - fetch with `RateLimitedError` → `moveToDelayed` + `DelayedError`;
  - 304 handling (eauction);
  - zero blocks on 200 → throw;
  - page payload storage;
  - the per-notice `existsWithHash` → enqueue → record loop, enqueuing **before** recording;
  - `markSweepHealthy`;
  - continuation and watermark commit.
- [ ] Each source plugs in its page reader, watermark value per notice, watermark key, and notice →
      `{ ref, hash, job }` mapping, plus any per-notice skip, such as gnumner's coverage counts and
      excluded buyers. No branching on source names inside the shared module.
- [ ] One cap rule for all sources: `maxListingPages` applies only to a cold start (no watermark).
      With a watermark the chain walks until it reaches it, bounded only by the global
      `SCRAPER.MAX_LISTING_PAGES`. A chain that ends without reaching the watermark logs a warning
      naming how far it got.
- [ ] Whether to continue depends on a next page existing, not on the site's reported page total,
      for every source. If e-auction's pager can't answer "is there a next page" any other way, say
      so here and keep its page total only as that answer.
- [ ] e-auction behaviour is otherwise unchanged: a live sweep over known tenders writes 0 rows and
      enqueues 0 jobs, and its log lines still carry blocks, usable rows, changed rows and the
      stop reason.
- [ ] gnumner behaviour is unchanged: re-run ticket 04's page-1 counts and repeat sweep, with the
      same numbers.
- [ ] The outage case is checked by hand on e-auction: set its watermark far enough back that the
      gap exceeds `maxListingPages`, sweep, and confirm the chain passes page 40 and commits only
      after reaching the old watermark. Record it here. Use a throwaway Redis DB, or restore the
      watermark afterwards.
- [ ] CLAUDE.md's ingestion section describes the one rule, and docs/SCRAPER_WORKFLOW.md too if it
      describes the old cap.
