# 08 — A checklist generation spends the quota

**What to build:** Every organization can request only as many checklist generations a month as
its quota allows, and every accepted request spends one. A `free` organization can no longer
generate at all. A tender with no stored invitation is refused at once with a reason and costs
nothing, and no other refusal costs anything either. When the quota is spent, the refusal says
how many were used, the limit, and when it resets. Spec: `.scratch/subscriptions/quota-spec.md`
(§ *What counts*, *Up-front invitation check*, *Recording and the window*, *Enforcement*). The
term Quota is in CONTEXT.md.

**Blocked by:** None — can start immediately (tickets 01–06 are done; 07 is independent).

**Status:** done

- [x] A new private table records each accepted generation: organization, tracked tender, the
      requesting user, and when. The tracked tender is a composite foreign key on
      `(tracked_tender_id, organization_id)`, and deleting a pursuit keeps the row with only
      `tracked_tender_id` nulled (`ON DELETE SET NULL (tracked_tender_id)`), so no generation is
      refunded. Only repositories touch it.
- [x] The limits are one code constant beside the plan gates: `free` 0, trial 10, `starter` 5,
      `pro` 30, `business` 100, `enterprise` 300. A plan with no entry is 0.
- [x] The limit comes from the subscription covering now, and its kind, read at request time
      and never from the token. With no current subscription, the limit is 0.
- [x] Used is this organization's generations since the later of two moments: the first of the
      current month in Asia/Yerevan, and the current subscription's start. So a new subscription
      starts fresh. `resetsAt` is the first of next month at 00:00 Asia/Yerevan, as ISO-8601 UTC.
      Both are computed in SQL at that fixed time zone.
- [x] Order on generate: role gate → tracked tender found → AI configured → already in flight →
      invitation stored → quota (count and record) → enqueue. Every step before the quota is a
      refusal that costs nothing.
- [x] A tender with no stored invitation document answers `409 CONFLICT` with `details.reason`
      `no_document` or `unsupported_document`. It enqueues and records nothing, and leaves the
      checklist row as it was. The check is the database lookup the extractor begins with, with
      no storage read.
- [x] The quota step runs under the organization row lock. At `used >= limit` it answers
      `429 QUOTA_EXCEEDED` with `details: { used, limit, resetsAt }`. Otherwise it records the
      generation, and the job is enqueued after the commit. `force` counts like any other
      request.
- [x] Schema goes straight into `create_table.js` and `drop_table.js` (table, then its drop, in
      dependency order). No add-script and no Neon step. Check by building and dropping a scratch
      database.
- [x] Verified by hand against local `tendra` with throwaway rows (removed afterwards):
  - `free` org → 429 with limit 0;
  - trial org: 10 × 202, then the 11th → 429;
  - last month's generations do not count;
  - a promo started mid-month (trial `end`) → full 30;
  - a tender with no invitation → 409 `no_document`, used unchanged;
  - in-flight 409 → used unchanged;
  - two concurrent generates at used = limit − 1 → exactly one 202.
- [x] `docs/API_REFERENCE.md` documents the generate endpoint's new refusals.
      `docs/AI_COST_MODEL.md` § *Quota design sketch* says what was built (the trial line and the
      window). CLAUDE.md § *Subscriptions* gets one bullet.
- [x] When done: tick the boxes, add a "Done" section with the verification table, set **Status:**
      to done, commit (`feat(subscriptions): a checklist generation spends the quota; close
      subscriptions ticket 08`), and push the current branch to `origin` and `gitlab`.

## Done (2026-11-05)

`checklist_generations` (`id`, `organization_id` → `organizations` CASCADE, `tracked_tender_id`,
`requested_by` → `users` SET NULL, `created_at`; index `(organization_id, created_at)`) is in
`create_table.js`, with `checklist_generations_tracked_org_fk` on `(tracked_tender_id,
organization_id)` → `tracked_tenders (id, organization_id)` `ON DELETE SET NULL
(tracked_tender_id)` in `indexes()`, and dropped before `checklist_items` in `drop_table.js`. A
scratch database built with `migrate:up` carries both; `migrate:down` leaves 0 tables. Local
`tendra` got the same table by a hand-run `CREATE TABLE`. **Neon is not touched.**

- **Limits.** `libs/permissions.js#CHECKLIST_QUOTA` beside `PLAN_GATED`, `TRIAL_CHECKLIST_QUOTA`
  10, and `checklistQuotaFor(period)`: a trial is 10 whatever its plan, a plan with no own entry
  is 0, no period is 0.
- **Repository.** `checklistGeneration.repo.js`: `usage(organizationId, subscriptionId)` counts
  since `greatest(Yerevan 1st, that period's period_start)`, the start read in SQL rather than
  passed as a Date, and returns `resetsAt` = next Yerevan 1st; `record(...)`.
- **Service.** `features/subscriptions/quota.service.js`: `read` (limit from
  `subscription.repo.js#current`, never the token) and `spend`, which locks the organization row,
  refuses `QUOTA_EXCEEDED` with `{ used, limit, resetsAt }`, else records. `read` is what ticket
  09's view will call.
- **Generate.** `ChecklistService.generate`: found → AI configured → in flight → invitation
  stored (`ChecklistExtractionService.invitationOf`, the rule `loadInvitationText` now uses too,
  over `findWithStoredDocuments`, no storage read) → `QuotaService.spend` (commits) → the
  existing ensure/mark-pending/queue. The controller passes `req.user.id` as `requested_by`.

**Verified by hand** (API on :5055 with a dummy `ANTHROPIC_API_KEY` and no worker running, so no
model was called; local `tendra`, throwaway `t08-*@example.com` users, organizations, pursuits,
a promo code, and the 18 queued jobs — all removed afterwards, 0 rows left):

| step | result |
|---|---|
| `free` org: generate | 429 `QUOTA_EXCEEDED` `{ used: 0, limit: 0, resetsAt: "2026-11-30T20:00:00.000Z" }` (1 Dec 00:00 Yerevan) |
| trial org: 10 generates on 10 pursuits | 10 × 202 |
| trial org: 11th | 429 `{ used: 10, limit: 10 }`; 10 rows |
| tender with no stored document | 409 `no_document`; used 10 → 10; no checklist row written |
| tender with documents but no invitation | 409 `unsupported_document`; used unchanged |
| redeem a 100% pro code with `trial: "end"`, then generate | 201, then 202; quota `{ used: 1, limit: 30 }` |
| generate a pursuit whose job is queued, then again, then with `force` | 202, 409, 409; used 12 → 12 |
| pro promo started 40 days ago, 30 rows dated 1 s before this Yerevan month: generate | 202 (last month's do not count) |
| used 29 / 30, two generates at once on two pursuits | 5 rounds: one 202 and one 429 each, used 30 each time, no 500 in the log |
| a pursuit with a generation deleted | its row kept, `tracked_tender_id` NULL |

Known and accepted: two generates for the **same** pursuit racing past the in-flight check (both
before either job is queued) both spend a unit, since the in-flight state lives in Redis and the
job is queued only after the commit. The second `add` is a no-op under the same job id. The
spec's order puts the in-flight check before the quota, so it is outside the lock.
