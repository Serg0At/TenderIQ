# 25 — An e-auction tender's CPV codes reach its alert

**What to build:** A supplier whose saved search names a CPV code an e-auction tender states hears
about that tender when it is published, not only if a keyword happens to hit. Found in ticket 17:
an e-auction detail page carries no CPV — the codes live only in the invitation archive — and the
normalizer queues the `match.tender` job and the `tender.documents` job **at the same moment**.
The match runs on the alerts queue at once; the archive download waits on the 20/min politeness
budget. So the matcher reads a tender with no code at all, finds no CPV match, and nothing
re-runs it once the codes land: `applyInvitationFacts` raises no event.

**Blocked by:** None — ticket 17 is done.

**Status:** needs-triage

Measured on the local `tendra` database and Redis, 2026-10-20: of 851 e-auction `match-…-v1`
jobs in `bull:alerts`, 787 had a stored invitation and **all 787 were queued before it was
stored** (0 the other way round; the other 64 have no invitation). For an e-auction, a CPV-only
saved search has effectively never fired at ingest. A later `TenderAmended` carries the codes, but
the status moves that amend an e-auction (Նախաաճուրդային, Աճուրդ, …) are not alertable, so that
does not rescue it. ARMEPS is not affected: its page states its codes, and ticket 17 puts every
one of them on the tender before the match runs (lot codes still arrive later, with the
documents, but every lot code is also on the page).

Decisions this needs, not taken here:

- [ ] When the codes first land (the document stage writes a code list where there was none),
      re-run the match for the tender. Under which job id — `match-{id}-v{version}` is already
      taken by the ingest match, and BullMQ keeps a finished job's id — and as which event:
      `TenderIngested`, so the organization gets a `tender-match` and not an `amendment` for a
      tender it never heard of. Notification dedupe already makes a second run silent for an
      organization that was alerted by keyword.
- [ ] **A backfill must not alert on old tenders.** `documents:backfill` and the archive seed
      write invitation facts for tenders published long ago; only a live ingest (not
      `PRIORITY.BACKFILL`, not a status that is no longer alertable) may trigger the re-match.
      Record how that is told apart.
- [ ] Or the alternative: hold the ingest match until the documents stage has run (or failed for
      good) for sources whose page states no CPV. That delays every e-auction alert by the
      archive's queue time against NFR-PERF-4 (< 5 min after ingestion); record which is chosen
      and why.
- [ ] Verified on the local database with a throwaway saved search on a code that only an
      invitation states: published → documents stored → one `tender-match` notification, and a
      replay or a `documents:backfill` run raises none.
