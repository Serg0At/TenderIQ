# 09 — The quota in the subscription view

**What to build:** Every member can see how many checklist generations the organization has used
this month, its limit, and when it resets, before anyone presses generate. Spec:
`.scratch/subscriptions/quota-spec.md` (§ *Visibility*).

**Blocked by:** 08 — A checklist generation spends the quota.

**Status:** done

- [x] `GET /organization/subscription` adds `quota: { used, limit, resetsAt }`, readable by every
      member (`tender:read`).
- [x] It reads the same used, limit and reset computation ticket 08 enforces. There is no second
      definition, so the view and the 429 can never disagree.
- [x] With no current subscription it reads `limit: 0`, with `used` as counted.
- [x] Verified by hand against local `tendra`: the view's `used` rises by one per accepted
      generate, stays put on a refusal, and matches the `details` of the next 429.
- [x] `docs/API_REFERENCE.md` documents the field.
- [x] When done: tick the boxes, add a "Done" section, set **Status:** to done, commit
      (`feat(subscriptions): the quota in the subscription view; close subscriptions ticket 09`),
      and push the current branch to `origin` and `gitlab`.

## Done (2026-11-05)

`SubscriptionService.current` adds `quota: await QuotaService.read(organizationId)` — the same
function `QuotaService.spend` reads under the lock before it refuses, so there is one definition
of used, limit and `resetsAt`. The trial-start and redeem responses embed that view and carry
`quota` too. `docs/API_REFERENCE.md` documents the field and the three examples show it. No
schema change.

**Verified by hand** (API on :5055 with a dummy `ANTHROPIC_API_KEY`, no worker; local `tendra`,
throwaway `t09-*@example.com` users and organizations, a viewer membership and the 10 queued jobs,
all removed afterwards):

| step | view's `quota` |
|---|---|
| `free` organization | `{ used: 0, limit: 0, resetsAt: "2026-11-30T20:00:00.000Z" }` |
| `free`, one generation row this month | `used: 1, limit: 0`; generate → 429 with the same three |
| trial organization before starting | `used: 0, limit: 0` |
| trial start response | `used: 0, limit: 10` |
| generates 1, 2, 3 (202 each) | `used` 1, 2, 3 |
| 409 `no_document`, then 409 in flight | `used` stays 3 |
| a viewer of the organization | `used: 3, limit: 10` |
| 7 more generates | `used: 10, limit: 10` |
| 11th generate | 429 `details` `{ used: 10, limit: 10, resetsAt: "2026-11-30T20:00:00.000Z" }`, identical to the view before and after |
