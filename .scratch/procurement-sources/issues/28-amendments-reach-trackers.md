# 28 — An amendment reaches the organizations tracking the tender

**What to build:** An organization that tracks a tender (`tracked_tenders`) hears about its
amendments (a moved deadline, an addendum) even when none of its saved searches matches it.
Found in the ticket 18 review on 2026-10-20: the ticket says "suppliers who matched **or track**
that tender are told", but the amendment path goes through `workers/matcher.js`, which reaches
only organizations whose saved searches match.

**Blocked by:** None. Ticket 18 is done.

**Status:** ready-for-agent

**Triage (2026-10-20):**

- **Pursuit states: `considering`, `preparing` and `submitted`.** On ARMEPS and paper, a sealed bid
  can be withdrawn or replaced before the deadline. So an addendum or a moved deadline after
  submission is exactly when a supplier needs to know. Tendra's own locked snapshot does not
  change that. `won`, `lost` and `dropped` are excluded.
- **One job, one producer:** the matcher resolves the recipients of an amendment as the matched
  organizations ∪ the tracking organizations. A second producer would be a second answer to "who
  hears about this amendment", the same reason there is one notifier engine. Both use the same
  type and subject (`amendment`, `v{version}`), so an organization that matches *and* tracks
  gets one notification.
- **Amendments only.** Ingest alerts stay saved-search only: an organization tracking a tender
  already knows it exists.
- **Ticket 18's "open" rule still applies** (alertable status, deadline ahead). Results for a
  tracked tender come through bid reconciliation, not amendment alerts.

Acceptance:

- [ ] A tracking organization with no matching saved search gets exactly one alert per amendment
      version. One that also matches gets one, not two. `won`, `lost` and `dropped` get none.
- [ ] Verified with throwaway organizations on a real amended tender (ticket 18's 12544122 is
      v2 `amended`). Delete them afterwards.

Open questions, now answered above:

- Which pursuit states count: `considering` and `preparing` only (as the pipeline countdown), or
  `submitted` too? A submitted bid is a locked snapshot, but an addendum after submission may
  still matter to the supplier.
- One notification per organization when it both matches and tracks: the dedupe key
  `(org, 'amendment', tender, v{version})` already gives that, provided both paths use the same
  type and subject.
- Do saved-search matches and tracking share one job (the matcher resolves both), or does each
  get its own producer?
