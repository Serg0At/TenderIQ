# 28 — An amendment reaches the organizations tracking the tender

**What to build:** An organization that tracks a tender (`tracked_tenders`) hears about its
amendments (a moved deadline, an addendum) even when none of its saved searches matches it.
Found in the ticket 18 review on 2026-10-20: the ticket says "suppliers who matched **or track**
that tender are told", but the amendment path goes through `workers/matcher.js`, which reaches
only organizations whose saved searches match.

**Blocked by:** None. Ticket 18 is done.

**Status:** done

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

- [x] A tracking organization with no matching saved search gets exactly one alert per amendment
      version. One that also matches gets one, not two. `won`, `lost` and `dropped` get none.
- [x] Verified with throwaway organizations on a real amended tender (ticket 18's 12544122 is
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

## Done (2026-10-20)

`workers/matcher.js` resolves an amendment's recipients with `alertRecipients`
(`services/matcher.service.js`): the matched organizations ∪ `trackedTenders.trackersOf(tender,
AMENDMENT_PURSUITS)`, one recipient per organization. A tracker no search matched gets
`matchedSearches: []`, `score: null`, `reasons: []`; every tracker gets `pipelineStatus`, which
both channels already render (the countdown's "📋 preparing" / "Your pipeline status").

**Verified** on 12544122 (v2, `amended`, deadline 2026-11-20) with 7 throwaway organizations, then
deleted (7 orgs, 1 user; the database is back to its one real organization):

| Organization | Alerts |
|---|---|
| tracks `preparing`, no search | 1 |
| tracks `submitted` + a matching search | 1, carrying both the search and `submitted` |
| matching search only | 1 |
| tracks `won` / `lost` / `dropped` | 0 each |
| tracks `considering` | 1 |

A second run of the same job created 0. A `TenderIngested` run alerted only the two organizations
with a search. An amendment job on an `active` tender whose deadline had passed returned
`skipped: deadline_passed`.

**A reopened tender alerts (checked 2026-10-20, no fix needed).** An amendment that moves a
deadline that has already passed into the future is judged by the new deadline. The matcher
reads the tender when the job runs, after `saveNormalized` has committed the new deadline, and
`deriveStatus` turns a deadline-`closed` tender back to `active`. Run end to end through the
real `normalizeTender`, using 12544122's stored armeps.am page copied under a throwaway ref,
with the deadline edited and a throwaway organization tracking at `preparing`:

1. Deadline 2026-10-15 (passed). The tender is stored at v1 `closed`, and its ingest match
   returned `skipped: status_closed`.
2. The same page with the deadline moved to 2026-12-01. The tender went to v2 `active` with
   `changedFields: ['status', 'deadline_at']`. The queued `match-…-v2` alerted the tracker
   once (`amendment`, `v2`, `pipelineStatus: preparing`), and running it again created
   nothing.

Deleted afterwards:
- the tender and its source link;
- both payload rows and their stored objects;
- the three queued jobs (two match jobs, one documents job);
- the organization and the user.

The buyer party is shared with the real 12544122 and was kept. `deadline_passed` drops only a job
whose tender still has a passed deadline when it runs. Example: the deadline moved back again
before a delayed job ran.

**Decided while building. Sergey to confirm:**

- **The deadline half of the open rule now applies to every amendment.** That covers the
  normalizer's field amendments and organizations that only match, not just addenda. Before this,
  a field amendment past the deadline alerted every matching organization as long as the status
  was alertable. Without the rule, a results page landing on a tracked tender would reach its
  trackers as an "amendment", which the triage rules out. `isOpen` moved into
  `matcher.service.js`, next to `ALERTABLE_STATUSES`, and `addendum.service.js` imports it from
  there. Side effect: a job that retries past the deadline is dropped as `deadline_passed`.
- **Tracking widens channels the way an empty search does.** An organization that tracks gets
  every channel it has linked, even if its only matching search names one (`channelsForMatches(…,
  { tracking })`). Tracking names no channel, so it means "however we can reach you". Before
  this, a search naming only Telegram kept that organization's amendment on Telegram alone.

**Review (`/code-review`).** Fixed:
- the stale "countdowns only" comments in both formatters;
- the recipient shape was built twice, and now has one builder;
- the channel rule moved out of the worker;
- `isOpen` moved to `matcher.service.js`;
- the counter was renamed.

Left as is: `trackersOf` reads across organizations, the same way `dueForCountdown` does. Its
result only leaves the method as a notification raised inside each organization.
