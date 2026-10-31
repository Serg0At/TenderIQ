# 02 — The owner starts a trial

**What to build:** An owner starts a 30-day Pro trial from the organization's settings, and the
full product works for them at once and for colleagues at their next refresh. A trial happens
once per organization creator, only for an organization that never had a subscription, and only
when the owner chooses (spec § *Subscription service*, stories 1–10).

**Blocked by:** 01 — A subscription is a dated period.

**Status:** ready-for-agent

- [ ] `POST /organization/subscription/trial` is the owner's only (`billing:manage`), is not
      plan-gated, and is rate limited.
- [ ] A started trial is a `trial` row on `pro`, starting now and lasting the configured
      `BILLING.TRIAL_DAYS` (default 30), validated where all config is.
- [ ] The trial row records the organization's creator, and a partial unique index on it allows
      one trial per creator, voided trials included. Inserting a second one directly fails.
- [ ] The response carries the subscription view and a fresh session for this organization, in
      the shape `POST /organizations` returns. An intelligence call with the new token answers
      200.
- [ ] Refused with `CONFLICT`, `details.reason: 'trial_unavailable'`, when the organization ever
      had a subscription, or when its creator already has a trial in another organization. A
      race on the unique index maps to the same answer, never a 500.
- [ ] The organization row is locked while availability is re-checked, so a trial cannot slip
      in beside a concurrent write.
- [ ] A coordinator, viewer, consultant or admin is refused with `ROLE_FORBIDDEN`.
- [ ] `trialAvailable` reads false after the trial starts, for this organization and for every
      other organization of the same creator.
- [ ] `docs/API_REFERENCE.md` documents the endpoint and its refusals.
