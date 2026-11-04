# 07 — A trial claim survives its organization

**What to build:** Deleting an organization no longer hands its creator another trial. Today a
trial is "used" only while its `subscriptions` row exists, and that row is deleted when its
organization is (`ON DELETE CASCADE`). So a creator who starts a trial, deletes the organization
(sole owner, name typed back) and creates a new one can start a second trial with the same
account and no new email. Found in the post-build review, 2026-11-01. Sergey chose to record the
claim against the person, outside any organization.

**Blocked by:** None — can start immediately (tickets 01–06 are done).

**Status:** done

- [x] A new table records that a person has claimed their trial: the user (primary key, so one
      claim per person), when it was claimed, and the subscription it started (nullable, set to
      null when that row goes). It does not reference `organizations`, so deleting an
      organization leaves it in place. It is not a private table: it belongs to a person, not a
      tenant, and is read only by the trial check.
- [x] Starting a trial inserts the claim in the same transaction as the trial row, under the
      organization row lock as today. A primary-key violation answers the same `CONFLICT
      trial_unavailable`, never a 500. That makes the claim, not a partial index, what settles
      the race between two organizations of one creator.
- [x] `trialAvailable` and the trial re-check read the claim for the organization's creator,
      together with "this organization never had a subscription". The trial-creator column and
      its partial unique index on `subscriptions` are removed, and nothing reads them.
- [x] A voided trial still counts as claimed: voiding touches the subscription, never the claim.
- [x] Schema change goes straight into `create_table.js` and `drop_table.js` (table, then its drop
      in dependency order). No `add_*.js` script and no Neon step: Neon is recreated from the
      full schema. Check it by building and dropping a scratch database. Local `tendra` gets a
      hand-run `ALTER` only if needed for the hand test.
- [x] Verified by hand against local `tendra` with throwaway rows (removed afterwards):
  - start a trial, delete the organization, create a new one as the same user → `trialAvailable`
    false and `POST /organization/subscription/trial` answers 409 `trial_unavailable`;
  - a second user's organization is unaffected;
  - two organizations of one creator starting a trial at once → exactly one 201.
- [x] CONTEXT.md's Trial entry, ADR 0005's consequences, spec § *Schema*, CLAUDE.md
      § *Subscriptions* and `docs/API_REFERENCE.md` (the refusal reasons for the trial endpoint)
      say that a trial claim outlives the organization it was started in.
- [x] When done: tick the boxes, add a "Done" section with the verification table, set **Status:**
      to done, commit (`fix(subscriptions): a trial claim survives its organization; close
      subscriptions ticket 07`), and push the current branch to `origin` and `gitlab`.

## Done (2026-11-04)

`trial_claims` (`user_id` primary key → `users` `ON DELETE CASCADE`, `claimed_at`,
`subscription_id` → `subscriptions` `ON DELETE SET NULL`) is in `create_table.js`, dropped before
`subscriptions` in `drop_table.js`. `subscriptions.trial_creator_id` and
`subscriptions_trial_creator_uq` are gone. A scratch database built with `migrate:up` carries the
table and neither the column nor the index; `migrate:down` leaves 0 tables. Local `tendra` got a
hand-run `CREATE TABLE trial_claims`, `DROP INDEX subscriptions_trial_creator_uq` and `DROP
COLUMN trial_creator_id` (it held no trial rows to backfill). **Neon is not touched.**

- **Repository.** `creatorHasTrial` became `hasClaimedTrial(userId)`, reading `trial_claims`.
  `createTrial` inserts the trial, then the claim naming it, and returns null on a violation of
  `trial_claims_pkey`. `voidPeriod` touches only the subscription.
- **Service.** `current` and `startTrial` read `hasClaimedTrial(organization.created_by)` beside
  `everHad`; the refusal is unchanged. `organizations.created_by` is `NOT NULL` and `RESTRICT`,
  so a creator always exists to claim against.

**Verified by hand** (API on :5055, local `tendra`, throwaway `t07-*@example.com` users and their
organizations, removed afterwards — 0 users, 0 claims, 0 orphan subscriptions left):

| step | result |
|---|---|
| A: new organization | `trialAvailable: true` |
| A: `POST /trial` | 201; one `trial_claims` row naming the trial |
| A: `DELETE /organization` (name typed back) | 200; claim still there, `subscription_id` now NULL |
| A: new organization, same user | `trialAvailable: false`; `POST /trial` 409 `trial_unavailable` |
| B (second user): new organization | `trialAvailable: true`; `POST /trial` 201 |
| B: trial voided (SQL), second organization | `trialAvailable: false`; `POST /trial` 409 |
| 5 rounds of two organizations of one creator, `POST /trial` in parallel | 5 × 201, 5 × 409, one trial row per creator, no 500 in the log |

The primary-key path, which HTTP cannot single out from the re-check, was tested through the
repository in a rolled-back transaction: `createTrial` for the race loser's organization, whose
creator already holds a claim, returns null.
