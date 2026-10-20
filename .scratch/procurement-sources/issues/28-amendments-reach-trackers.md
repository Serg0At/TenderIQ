# 28 — An amendment reaches the organizations tracking the tender

**What to build:** An organization that tracks a tender (`tracked_tenders`) hears about its
amendments (a moved deadline, an addendum) even when none of its saved searches matches it.
Found in the ticket 18 review on 2026-10-20: the ticket says "suppliers who matched **or track**
that tender are told", but the amendment path goes through `workers/matcher.js`, which reaches
only organizations whose saved searches match.

**Blocked by:** None. Ticket 18 is done.

**Status:** needs-triage

Open questions for triage:

- Which pursuit states count: `considering` and `preparing` only (as the pipeline countdown), or
  `submitted` too? A submitted bid is a locked snapshot, but an addendum after submission may
  still matter to the supplier.
- One notification per organization when it both matches and tracks: the dedupe key
  `(org, 'amendment', tender, v{version})` already gives that, provided both paths use the same
  type and subject.
- Do saved-search matches and tracking share one job (the matcher resolves both), or does each
  get its own producer?
