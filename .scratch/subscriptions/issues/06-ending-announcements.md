# 06 — Ending announcements

**What to build:** Every member hears that the organization's period is about to end and that it
has ended, so the 402s that follow are never a surprise. Nobody is warned about an end that is
not one, because another period starts at that moment (spec § *Ending announcements*, stories
21–23).

**Blocked by:** 01 — A subscription is a dated period.

**Status:** ready-for-agent

- [ ] A daily sweep runs on the alerts queue, registered by the scheduler like the vault expiry
      sweep, with its queue and job names as constants.
- [ ] A non-voided period ending within 3 days raises a `subscription-ending` announcement. A
      period that has ended raises `subscription-ended`. Both go through the team announcement
      path, organization-wide.
- [ ] Neither is raised when a non-voided period of the same organization starts at that
      period's end.
- [ ] The dedupe subjects are one per period per event, so repeated sweeps announce each period
      once each way.
- [ ] The wording is third person and names the plan, the kind and the date, never a person.
- [ ] By hand: periods inserted by SQL with an end two days away, an end yesterday, and an end
      followed by another period produce exactly two announcements across two sweep runs.
