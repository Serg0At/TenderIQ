# 03 — The operator, and the promo-code console

**What to build:** The person running Tendra can create promo codes, see how they are being used,
and delete or disable them, through an API no organization member can reach, admins and owners
included. "Operator" is a property of the user, never of a membership (spec § *API* operator
routes, § *Token*, stories 27–34, 37–39).

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [x] Users carry an operator flag, false by default and set only by hand (SQL or script).
- [x] Session mint and refresh read the flag from the database the way they read the role, and
      the token carries an `op` claim. Clearing the flag ends operator access at the next refresh.
- [x] An operator gate refuses everyone without the claim with `ROLE_FORBIDDEN`. The operator
      routes are mounted on the orgless authentication with the gate, and the reason they join
      the orgless allowlist is written beside the allowlist.
- [x] `promo_codes` holds code text (unique, stored upper-cased and trimmed), plan, percent off
      (1–100), length in months (≥ 1), redemption limit (nullable = unlimited), redemption count,
      optional last redemption date, disabled time, creating operator, and creation time.
- [x] `POST /operator/promo-codes` creates a code. `free` is refused as its plan, and a duplicate
      code text is `CONFLICT`.
- [x] `GET /operator/promo-codes` lists codes with redemption count, limit, last redemption date
      and disabled time, cursor-paginated with an id tiebreaker.
- [x] `DELETE /operator/promo-codes/:id` deletes a code that was never redeemed, and otherwise
      disables it. The response says which happened.
- [x] An owner who is not an operator gets 403 on every operator route.
- [x] Schema through the additive-script workflow. *(Overruled 2026-11-01: written straight
      into `create_table.js` / `drop_table.js`, no additive script.)* `docs/API_REFERENCE.md` documents the
      operator routes, and CONTEXT.md's Operator entry still holds.

## Done (2026-11-01)

- `users.is_operator`, `promo_codes` and its CHECKs, in `create_table.js` / `drop_table.js`
  directly — no additive script, by the product owner's call. `promo_codes` is created before
  `subscriptions`, whose `promo_code_id` now references it (`ON DELETE RESTRICT`), the key
  ticket 01 left for this ticket. Checked by building a scratch database from `create_table.js`
  and dropping it with `drop_table.js`. Local `tendra` already has the shape (applied by a
  since-deleted script); Neon gets it whenever its schema is next rebuilt.
- `op` claim from `issueTokens`, set from `users.is_operator` in `sessionFor`, the orgless
  session and both branches of `refresh`. Every session and refresh response carries
  `operator`. Gate: `authorizeOperator` (`middlewares/authorize.js`), mounted with
  `authenticateOrgless` on `/operator` (`features/operator/`).
- Decided while building: code text is ASCII letters, digits, `-`, `_` (Armenian and Cyrillic
  have Latin look-alikes, and JS and Postgres upper-casing agree only on ASCII);
  `redeemableUntil` must be in the future; `durationMonths` ≤ 120 and `maxRedemptions` ≤ 10⁶ so
  an integer overflow is a 422, not a 500; `created_by` is `ON DELETE SET NULL`. Delete-or-disable
  is one conditional `DELETE … WHERE redemption_count = 0` and then a disable, so a concurrent
  redemption turns the delete into a disable; a foreign-key refusal does the same, inside a
  savepoint.

**Verified by hand** against local `tendra` on a fresh API (39 checks, all passing): an owner
without the flag gets `403 ROLE_FORBIDDEN` on POST, GET and DELETE (and an orgless session too),
and a refused POST writes no row; with the flag set by SQL the old token is still refused, and after
`/auth/refresh` the session says `operator: true` and every route works, orgless included. Create
trims and upper-cases, a different-case duplicate is `409`, `free` and an unknown plan are `422`;
the list pages newest-first with no repeat across the cursor; an unredeemed code is `deleted`, one
with a redemption is `disabled` and keeps its first `disabledAt` when disabled again, an unknown id
is `404`. Clearing the flag and refreshing gives `403` again. The CHECKs refuse a lower-case code
and a count past the limit, and a code a subscription points at is disabled, not deleted, both
with and without a caller's transaction.

