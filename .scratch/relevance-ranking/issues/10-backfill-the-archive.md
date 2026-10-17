# 10 — Load the archive so the ranking has a history to read

**What to build:** No feature code. The corpus stops being two months deep.

The ranking is built and shipped against 429 tenders and a bid ledger covering 188 of them, where
the median supplier has bid on exactly one tender and only 68 suppliers have bid on five or more.
Every code path works at that size; no weight can be judged at it. Ticket 11 needs real history,
and so does any honest claim that the feature helps.

The backfill worker and its own queue already exist for this. The work here is running it across
the archive's page range, watching it finish, and reporting what the corpus looks like afterwards
— how many tenders, how many carry CPV, how deep the ledger goes, and how many suppliers now have
enough history to be rankable.

That last number is the one that matters: if most suppliers still have only a handful of bids
after the archive is loaded, the ledger signals are weaker than this feature assumed, and ticket
11 should say so rather than tuning around it.

Expect CPV coverage to drop sharply on archive rows: the code lives in the invitation archive,
which is fetched for current tenders and not for old ones. That is the finding which decides
whether the one-off AI tagging batch described in the spec is ever worth running.

**Blocked by:** None — can start immediately, and can run in the background while 01–09 proceed.

**Status:** ready-for-agent

- [ ] The archive is loaded through the existing backfill path, on its own queue and process, with
      no change to the live sweep.
- [ ] The run is idempotent in practice: re-running it writes no duplicates, consistent with the
      dedupe anchors ingestion already relies on.
- [ ] Afterwards, the corpus size, CPV coverage overall and on biddable tenders, ledger depth, and
      the distribution of bids per supplier are measured and written down.
- [ ] The number of suppliers with enough history to rank on is stated plainly, including whether
      it is too few.
- [ ] Whether archive CPV coverage is poor enough to justify the one-off AI tagging batch is
      answered with a number, not an impression.
- [ ] The freshness signal and the live sweep are unaffected by the run.
