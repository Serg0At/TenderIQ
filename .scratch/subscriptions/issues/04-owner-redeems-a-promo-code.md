# 04 — The owner redeems a promo code

**What to build:** An owner types in a code. A 100% code turns into a subscription of the code's
plan and length with no checkout. During a trial, the owner chooses to keep the remaining trial
days or to end the trial now. Everything else is refused with a reason the client can show
(spec § *Subscription service* `redeem`, stories 11–20, 26, 43).

**Blocked by:** 01 — A subscription is a dated period; 02 — The owner starts a trial; 03 — The
operator, and the promo-code console.

**Status:** done

- [x] `POST /organization/subscription/redeem` with `{ code, trial?: 'keep' | 'end' }` is the
      owner's only (`billing:manage`) and is rate limited per user.
- [x] The code is matched regardless of case and surrounding spaces.
- [x] An unknown, disabled, past-deadline or used-up code is refused with `VALIDATION_FAILED`
      and `details.reason: 'code_invalid'`. The message and shape are identical for all four.
- [x] A code below 100% is refused with `VALIDATION_FAILED` and `details.reason:
      'payments_unavailable'`, and nothing is written.
- [x] A current promo (or paid) period refuses with `CONFLICT`, `promo_active`. A code this
      organization already redeemed, voided included, refuses with `CONFLICT`,
      `already_redeemed`, which a partial unique index enforces.
- [x] During a current trial, a missing `trial` choice is `VALIDATION_FAILED` naming the field.
      `keep` starts the promo at the trial's end. `end` shortens the trial's end to now and
      starts the promo now. The two periods never overlap.
- [x] With no current period, the promo starts now. Either way it lasts the code's length in
      calendar months.
- [x] The redemption count rises through a conditional update against the limit, all in the
      same transaction under the organization row lock. A code allowed one use, redeemed by a
      second organization, answers `code_invalid`.
- [x] The response carries the subscription view and a fresh session, whose plan is the code's.
- [x] By hand, against the local database: redeem with `keep` and with `end` during a trial, and
      check both resulting periods and `GET /organization/subscription`'s `current`/`next`.
- [x] `docs/API_REFERENCE.md` documents the endpoint and every refusal reason.

## Done (2026-11-01)

`subscriptions_promo_code_org_uq` (`ON subscriptions (promo_code_id, organization_id) WHERE
promo_code_id IS NOT NULL`) is in `create_table.js`'s `indexes()` and was applied to local
`tendra` by hand. It drops with its table. **Neon is not touched**: it is rebuilt from the full
schema, or needs the same hand-run `CREATE UNIQUE INDEX`.

- **Repositories.** `promoCode.repo.js` holds `REDEEMABLE_SQL` (not disabled, before its
  deadline, below its limit), the one definition read by `findByCode` and by `countRedemption`'s
  conditional UPDATE. `subscription.repo.js` gained `unendedGrant`, `hasRedeemed`,
  `endTrialNow` (trials only, never lengthens) and `createPromo`, which returns null on the new
  index. `createPromo` reads a kept trial's end **in SQL**: a Date handed back from a fetched row
  holds milliseconds, so the promo would start up to 1 ms inside the trial and hit the overlap
  exclusion. Months are added on the Yerevan calendar whatever the session's time zone. Local
  Postgres runs in Asia/Yerevan and Neon probably in GMT, so unpinned, the two would disagree
  about where a month ends.
- **Service.** `SubscriptionService.redeem`, one transaction under the organization lock, in
  the spec's order. The owner check is shared with `startTrial` (`assertOwner`). `CODE_INVALID`
  is a frozen module constant.
- **Decided while building:** `promo_active` also covers a promo **still to come**, the one a
  kept trial leaves as `next`. The spec says "current", but a second code redeemed then could
  only overlap it, and the exclusion would answer 500. Because `promo_active` is checked before
  `already_redeemed`, an organization re-entering the code of its running promo is told
  `promo_active`. Confirmed by Sergey 2026-11-01, and the spec and ADR 0005 now say "current or
  scheduled".
- **Changed after review (2026-11-01):** a one-use code the organization itself used up first
  answered `code_invalid`, telling the owner the code was wrong. Now "used up" is refused as
  `code_invalid` only when this organization is not among its redeemers, so the owner who spent
  it reaches `already_redeemed` (or `promo_active` while it runs). Every other organization still
  gets the one constant answer for all four invalid cases.
- **Route.** `POST /organization/subscription/redeem`: `authorize('billing:manage')`, a limit of
  10 an hour per user (bucket `promo-redeem`), then `validate(redeemSchema)`.
  `subscription.schema.js` bounds `code` and never pattern-checks it, so a malformed code is
  simply unknown rather than one more answer.

**Verified by hand** (API on :5055, local `tendra`, throwaway users, organizations and codes,
removed afterwards):

| step | result |
|---|---|
| trial running, no `trial` | 422, `details: [{ field: "trial" }]`; `trial: "maybe"` 422 from Joi |
| `keep`, code typed lower-case with spaces | 201; trial unchanged, promo `[trial end, +6 months)` to the microsecond; view `current` trial, `next` promo; session `pro` |
| `end` | 201; trial `period_end` = promo `period_start` = the transaction's `now()`; view `current` promo, `next` null |
| another code while a kept promo waits | 409 `promo_active` |
| same code while that promo is current | 409 `promo_active` |
| same code after the promo lapsed (dates moved back by SQL), and after voiding it | 409 `already_redeemed` both |
| one-use code: org D redeems, org C tries | 201, then 422 `code_invalid`; `redemption_count` 1 |
| one-use code, two orgs in parallel | one 201, one 422 `code_invalid`; count 1 |
| after review: org D re-enters the one-use code it used up, promo running | 409 `promo_active` |
| the same, after D's promo lapsed (dates moved back by SQL) | 409 `already_redeemed` |
| the same code from org C, which never redeemed it | 422 `code_invalid`, byte-identical to an unknown code |
| 50% code | 422 `payments_unavailable`, `percentOff: 50`; 0 periods, count 0 |
| unknown, disabled, past deadline, used up | 422 `code_invalid`; **one** distinct (status, body) across the four |
| `business` code, no period | 201; session `business`; `/benchmarks/30000000` with it 200 |
| 11 attempts in an hour | 10 × 422, then 429 |
| viewer | 403 `ROLE_FORBIDDEN` |

Months are on the Yerevan calendar: a promo kept from 2026-11-30 22:36 UTC (1 December, Yerevan)
ends 2027-05-31 22:36 UTC (1 June, Yerevan).

The index path, which HTTP cannot single out from `hasRedeemed`, was tested directly in a
rolled-back transaction. `createPromo` for a code the organization already redeemed, with that
period voided, returns null. A scratch database built with `migrate:up` carries the index, and
`migrate:down` leaves 0 tables.
