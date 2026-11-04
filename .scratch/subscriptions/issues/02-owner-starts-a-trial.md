# 02 — The owner starts a trial

**What to build:** An owner starts a 30-day Pro trial from the organization's settings, and the
full product works for them at once and for colleagues at their next refresh. A trial happens
once per organization creator, only for an organization that never had a subscription, and only
when the owner chooses (spec § *Subscription service*, stories 1–10).

**Blocked by:** 01 — A subscription is a dated period.

**Status:** done

- [x] `POST /organization/subscription/trial` is the owner's only (`billing:manage`), is not
      plan-gated, and is rate limited.
- [x] A started trial is a `trial` row on `pro`, starting now and lasting the configured
      `BILLING.TRIAL_DAYS` (default 30), validated where all config is.
- [x] The trial row records the organization's creator, and a partial unique index on it allows
      one trial per creator, voided trials included. Inserting a second one directly fails.
- [x] The response carries the subscription view and a fresh session for this organization, in
      the shape `POST /organizations` returns. An intelligence call with the new token answers
      200.
- [x] Refused with `CONFLICT`, `details.reason: 'trial_unavailable'`, when the organization ever
      had a subscription, or when its creator already has a trial in another organization. A
      race on the unique index maps to the same answer, never a 500.
- [x] The organization row is locked while availability is re-checked, so a trial cannot slip
      in beside a concurrent write.
- [x] A coordinator, viewer, consultant or admin is refused with `ROLE_FORBIDDEN`.
- [x] `trialAvailable` reads false after the trial starts, for this organization and for every
      other organization of the same creator.
- [x] `docs/API_REFERENCE.md` documents the endpoint and its refusals.

## Done (2026-11-01)

`subscriptions_trial_creator_uq` (`ON subscriptions (trial_creator_id) WHERE kind = 'trial'`) is
in `create_table.js`'s `indexes()` and was applied to local `tendra` by hand. It drops with its
table. **Neon is not touched**: it is rebuilt from the full schema, or needs the same hand-run
`CREATE UNIQUE INDEX`.

- **Config.** `BILLING.TRIAL_DAYS` from `BILLING_TRIAL_DAYS`, default 30. `int()` gained opt-in
  `{ min, max }` bounds, and this setting uses 1–365. `0`, `366` and `abc` refuse to boot.
- **Repository.** `subscription.repo.js#createTrial` writes both ends from the database clock (the
  clock `current` reads against) and returns null on a violation of the creator index.
- **Service.** `SubscriptionService.startTrial`: lock the organization row, re-read the actor's
  role from `memberships` (a just-transferred owner's token still says owner), re-check
  `everHad` and `creatorHasTrial`, then insert. A refused re-check and a lost index race are the
  same `trialUnavailable()` refusal. After the commit it returns `{ subscription, session }`, with
  the session minted through `AuthService.sessionFor`.
- **Route.** `POST /organization/subscription/trial`: `authorize('billing:manage')`, then a limit
  of 10 an hour per user (bucket `trial-start`), the same order the invitation route uses.

**Verified by hand** (API on :5055, local `tendra`, throwaway users and organizations, removed
afterwards):

| step | result |
|---|---|
| new organization | view `{ current: null, next: null, trialAvailable: true }`; `/benchmarks/30000000` 402 |
| coordinator, viewer, consultant, admin `POST /trial` | 403 `ROLE_FORBIDDEN` each |
| owner `POST /trial` | 201; `session.plan` `pro`, same keys as `POST /organizations`; row `trial`, `pro`, exactly 30 days, `trial_creator_id` = creator; benchmark with the returned token 200 |
| owner `POST /trial` again | 409 `trial_unavailable` |
| view after | `trialAvailable: false`, `current.kind` `trial` |
| second organization of the same creator | view `trialAvailable: false`; `POST /trial` 409 `trial_unavailable` |
| organization with one voided promo, creator never trialled | `trialAvailable: false`; 409 `trial_unavailable` |
| 5 rounds of two organizations of one creator, both `POST /trial` in parallel | 5 × 201, 5 × 409 `trial_unavailable`, no 500 |

The index path, which HTTP cannot single out from the re-check, was tested directly in a
rolled-back transaction. `createTrial` for a second organization of a creator whose first trial
is **voided** returns null. A raw second trial insert fails with `duplicate key value violates
unique constraint "subscriptions_trial_creator_uq"` with the first one voided too. Two `promo`
rows carrying the same `trial_creator_id` are accepted, because the index is partial. A scratch
database built with `migrate:up` carries the index, and `migrate:down` leaves 0 tables.

