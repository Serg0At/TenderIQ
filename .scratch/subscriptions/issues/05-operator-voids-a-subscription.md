# 05 — The operator sees and voids an organization's subscriptions

**What to build:** The operator can answer "why is this company on Pro" and end a grant that was
a mistake or an abuse, for that one organization only. A voided period stops granting its plan,
but still counts as the organization's one trial or its one use of a code (spec § *API*
operator routes, stories 35–36).

**Blocked by:** 01 — A subscription is a dated period; 03 — The operator, and the promo-code
console.

**Status:** done

- [x] `GET /operator/organizations/:id/subscriptions` lists every period of that organization,
      voided ones included, with kind, plan, dates, the code it came from and void details.
- [x] `POST /operator/subscriptions/:id/void` records the void time and the operator. Repeating
      it is a success, not an error.
- [x] After a void, the organization's next refresh carries the plan of whatever else covers
      now, or `free`.
- [x] A voided trial still makes `trialAvailable` false, and the creator cannot start another.
      A voided promo still makes the same code `already_redeemed` for that organization.
- [x] Both routes are behind the operator gate. An owner who is not an operator gets 403.
- [x] `docs/API_REFERENCE.md` documents both routes.

## Done

No schema change: `voided_at` and `voided_by` were already in `create_table.js` from ticket 01,
and both rules of "a void still counts" already followed from it, so no logic was added for them.
`subscriptions_trial_creator_uq` and `subscriptions_promo_code_org_uq` have no `voided_at` in
their `WHERE`, and the reads they back (`creatorHasTrial`, `everHad`, `hasRedeemed`) never filter
on it. The reads that grant a plan (`current`, `next`, `unendedGrant`) all have
`whereNull('voided_at')`, and so does the overlap exclusion.

- **Repository.** `subscription.repo.js` gained `listForOrganization`, `findById` and
  `voidPeriod`. The last two take a period's id alone, the operator's exception to
  organization scoping, and the class comment now says so. `voidPeriod` updates only an unvoided
  row, so a repeat (or the loser of two concurrent voids) matches nothing and keeps the first
  `voided_at` and `voided_by`. It returns `voided`, `already_voided` or null. `coversNow` is
  computed in SQL with `COVERS_NOW_SQL`, the definition `current` uses.
- **Service.** `features/operator/operatorSubscription.service.js`. The list answers 404 for an
  unknown organization rather than an empty list, and a void answers 404 for an unknown period.
  The void is logged only when it changes something. The code's `redemption_count` is left alone,
  because a voided promo is still a use.
- **Routes.** `GET /operator/organizations/:id/subscriptions` and
  `POST /operator/subscriptions/:id/void`, on the existing `authenticateOrgless` +
  `authorizeOperator` router. The void answers 200 with the period as the list shows it.
- **Decided while building:** the list is not paginated. An organization gets one trial and one
  period per code, each after the last has ended, so it stays short.
- `docs/API_REFERENCE.md` documents both routes. Its endpoint counts went from 91 to 93.

**Verified by hand** (API on :5055, local `tendra`, throwaway users, organizations and codes,
removed afterwards):

| step | result |
|---|---|
| operator lists org A after it redeemed a 100% code | 200; one `promo` row, `coversNow: true`, `promoCode` `{ id, code }`, void fields null |
| void it | 200; `voidedAt` set, `voidedBy` the operator, `coversNow: false` |
| void it again | 200; same `voidedAt` |
| A's owner refreshes | 200, `plan: "free"`; view `{ current: null, next: null, trialAvailable: false }` |
| A redeems the same code | 409 `already_redeemed`; `redemption_count` still 1 |
| A starts a trial | 409 `trial_unavailable` (the voided promo counts as a subscription) |
| org B starts a trial, operator voids it, B's owner refreshes | 201 `pro` → 200 → `free`; `trialAvailable: false`; trial again 409 `trial_unavailable` |
| same creator founds org B2 | `trialAvailable: false`; trial 409 `trial_unavailable` |
| org C: trial running, `business` code kept behind it, operator voids the promo | C's refresh stays `pro` (the trial); `next` null; same code 409 `already_redeemed` |
| B's owner (no operator flag) on both routes | 403 `ROLE_FORBIDDEN`, `details.required: "operator"`; the trial stayed unvoided |
| unknown organization / unknown period | 404 "Organization not found." / 404 "Subscription not found." |
| no token | 401 |

Both indexes were also tested directly, in rolled-back transactions. A second trial row for B's
creator, whose trial is voided, fails `subscriptions_trial_creator_uq`. A second period of A's
voided code (dated a year out, so the overlap exclusion is not what fires) fails
`subscriptions_promo_code_org_uq`.

