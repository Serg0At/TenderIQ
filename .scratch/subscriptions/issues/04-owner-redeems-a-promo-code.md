# 04 — The owner redeems a promo code

**What to build:** An owner types in a code. A 100% code turns into a subscription of the code's
plan and length with no checkout. During a trial, the owner chooses to keep the remaining trial
days or to end the trial now. Everything else is refused with a reason the client can show
(spec § *Subscription service* `redeem`, stories 11–20, 26, 43).

**Blocked by:** 01 — A subscription is a dated period; 02 — The owner starts a trial; 03 — The
operator, and the promo-code console.

**Status:** ready-for-agent

- [ ] `POST /organization/subscription/redeem` with `{ code, trial?: 'keep' | 'end' }` is the
      owner's only (`billing:manage`) and is rate limited per user.
- [ ] The code is matched regardless of case and surrounding spaces.
- [ ] An unknown, disabled, past-deadline or used-up code is refused with `VALIDATION_FAILED`
      and `details.reason: 'code_invalid'`. The message and shape are identical for all four.
- [ ] A code below 100% is refused with `VALIDATION_FAILED` and `details.reason:
      'payments_unavailable'`, and nothing is written.
- [ ] A current promo (or paid) period refuses with `CONFLICT`, `promo_active`. A code this
      organization already redeemed, voided included, refuses with `CONFLICT`,
      `already_redeemed`, which a partial unique index enforces.
- [ ] During a current trial, a missing `trial` choice is `VALIDATION_FAILED` naming the field.
      `keep` starts the promo at the trial's end. `end` shortens the trial's end to now and
      starts the promo now. The two periods never overlap.
- [ ] With no current period, the promo starts now. Either way it lasts the code's length in
      calendar months.
- [ ] The redemption count rises through a conditional update against the limit, all in the
      same transaction under the organization row lock. A code allowed one use, redeemed by a
      second organization, answers `code_invalid`.
- [ ] The response carries the subscription view and a fresh session, whose plan is the code's.
- [ ] By hand, against the local database: redeem with `keep` and with `end` during a trial, and
      check both resulting periods and `GET /organization/subscription`'s `current`/`next`.
- [ ] `docs/API_REFERENCE.md` documents the endpoint and every refusal reason.
