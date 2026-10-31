Status: ready-for-agent

# F-02 · Subscriptions — trial, promo codes, and the operator console

Board task: `Add a writer for subscriptions so an org can hold a plan — unblocks the entire
intelligence layer (F-02)`, which replaces the earlier `A plan is a row with a period, not a
column` task. Decisions are recorded in ADR 0005. The terms Plan, Subscription, Trial, Promo code
and Operator are in CONTEXT.md.

## Problem Statement

Nothing in Tendra can put an organization on a paid plan. `subscriptions` has no writer, so every
organization reads `free`. Intelligence, relevance and sending invitations all answer 402 for
everyone, owners included, so the layer the product is sold on cannot be shown to the people it
is meant to win.

Taking money is not possible yet either. Card payments wait on a bank vPOS contract that is still
being negotiated, and bank transfer against a VAT invoice has been ruled out as a payment method.
In the meantime the product owner wants to gather real suppliers on the full product: a trial
anyone can start, plus codes he hands out personally or to a group that keep them on Pro until
payments exist.

The current shape cannot hold any of this. A subscription is one row per organization with a
status and a `renews_at`, and the plan lookup checks the status and never the date. A prepaid
year, a trial or a free code would therefore never end unless something remembered to flip it.

## Solution

An organization's plan comes from **subscriptions**: dated periods, one row each, read against
the clock.

- **Trial.** An owner starts a 30-day Pro trial from the organization's settings. It is free, it
  happens once, and it is not automatic: the owner chooses when to start it.
- **Promo codes.** An owner types in a promo code. A code at 100% off becomes a Pro (or other
  plan) period on the spot. A code below 100% is answered with "payments are not available yet",
  because there is no checkout to collect the rest.
- **When a code is redeemed during a trial**, the owner chooses to keep the remaining trial days
  (the promo starts when the trial ends) or to end the trial now.
- **Lapsing.** When the last period lapses, the organization is on `free` again. Nothing is
  deleted; only the plan gates close.
- **Reminders.** Every member is told in advance that the period is ending, unless another
  period follows it.

The **operator** (the person running Tendra) gets a small console: create promo codes with a
plan, a discount, a length, a redemption limit and an optional deadline; see how often each was
used; delete a code nobody has redeemed or disable one that has been; and void one organization's
subscription when it was granted in error or abused.

## User Stories

1. As an owner of a new organization, I want to start a free trial of the full product from the
   organization's settings, so that I can judge it on real tenders before paying.
2. As an owner, I want the trial to start when I choose rather than at sign-up, so that its 30
   days are not spent while I am still setting up saved searches and supplier identities.
3. As an owner, I want intelligence, relevance and invitations to work the moment I start the
   trial, so that I do not wait 15 minutes looking at "upgrade required".
4. As a coordinator in that organization, I want to gain the trial's features at my next session
   refresh without signing out, so that the trial reaches the whole team.
5. As an owner, I want to see that I am on a trial and the date it ends, so that I know how long
   I have to decide.
6. As a viewer, I want to see which plan my organization is on and until when, so that I
   understand why a feature is or is not available to me.
7. As an owner, I want the trial button to appear only when a trial is available to me, so that
   I am not offered something that will be refused.
8. As an owner who already used a trial in another organization I created, I want to be told
   the trial is not available, so that I understand why rather than seeing an error.
9. As an owner whose organization already had a promo period, I want no trial offered, so that
   the rules are visible rather than discovered.
10. As a coordinator, viewer, consultant or admin, I want the trial and redemption actions to be
    the owner's only, so that the organization's plan changes only through the person
    responsible for paying.
11. As an owner, I want to enter a promo code I was given, so that my organization stays on Pro
    without paying while payments are not yet available.
12. As an owner redeeming a 100% code, I want the new period to begin without any checkout, so
    that a free code is actually free.
13. As an owner redeeming a code during my trial, I want to choose between keeping my remaining
    trial days and ending the trial now, so that I can take the larger allowance now or the
    extra days later.
14. As an owner choosing to keep my trial days, I want the promo period to start the moment the
    trial ends, so that there is no gap in which my organization falls to `free`.
15. As an owner, I want a code with less than 100% off to be refused with a clear "payments are
    not available yet", so that I am not left at a checkout that does not exist.
16. As an owner, I want a mistyped, expired, disabled or used-up code to be refused with one
    clear message, so that I know to check the code with whoever gave it to me.
17. As an owner on a current promo period, I want to be told that another code cannot be
    redeemed until it ends, so that I do not burn a code by accident.
18. As an owner, I want to be told that my organization has already used this code, so that I
    ask for a new one instead of retrying.
19. As an owner, I want codes to be accepted regardless of letter case and stray spaces, so that
    typing one from a message or a flyer works.
20. As an owner, I want the plan change to land on my own session in the response, so that the
    newly unlocked features work at once.
21. As every member, I want an announcement a few days before our period ends, so that the
    owner can act before features disappear.
22. As every member, I want an announcement on the day the period ends, so that the 402s that
    follow are not a mystery.
23. As an owner whose trial is followed by a promo period, I want no "ending" announcement for
    the trial, so that I am not alarmed by an end that is not one.
24. As an owner whose period lapsed, I want my vault, pipeline, saved searches and team to be
    exactly as I left them, so that redeeming a code later picks up where I stopped.
25. As an owner whose period lapsed, I want to still be able to remove members, change roles and
    transfer ownership, so that shrinking the team never requires paying again.
26. As an owner whose promo lapsed, I want to redeem a new code I was given, so that the product
    owner can extend my pilot with no other tool.
27. As the operator, I want to create a promo code with a plan, a percentage off, a length in
    months, a redemption limit and an optional last redemption date, so that I can run a
    launch code and personal codes with one tool.
28. As the operator, I want a code with no redemption limit to be possible, so that the one
    shared launch code is not capped by accident.
29. As the operator, I want a code with no last redemption date to be possible, so that a
    personal code does not expire before the person uses it.
30. As the operator, I want to choose the code's text myself, so that a shared code is
    memorable (`LAUNCH100`).
31. As the operator, I want to see every code with how many times it was redeemed and by how
    many of its allowed uses, so that I know whether the launch code is spreading.
32. As the operator, I want to delete a code nobody has redeemed, so that a mistyped code leaves
    no trace.
33. As the operator, I want deleting a redeemed code to disable it instead, so that the
    subscriptions it granted keep their record of where they came from.
34. As the operator, I want disabling a code to leave already-granted periods running, so that
    closing the launch code does not cut off people who used it in good faith.
35. As the operator, I want to list one organization's subscriptions, so that I can answer
    "why is this company on Pro".
36. As the operator, I want to void one organization's subscription, so that an abused or
    mistaken grant ends without affecting anyone else.
37. As the operator, I want the console refused to everyone who is not an operator, admins and
    owners of organizations included, so that "admin" inside a tenant grants nothing over Tendra.
38. As the operator, I want my operator access to be removable and the removal to take effect
    within one access-token lifetime, so that a compromised operator account can be shut out.
39. As the operator, I want the console to work whether or not my session is inside an
    organization, so that operating Tendra never depends on my own membership.
40. As the product owner, I want trial length to be a configuration value, so that I can change
    it without a deploy of new code.
41. As the product owner, I want the database to refuse two subscriptions of one organization
    that overlap in time, so that "what plan is this organization on" always has exactly one
    answer.
42. As the product owner, I want the database to refuse a second trial for the same organization
    creator, so that two organizations pressing "start trial" at once cannot both get one.
43. As the product owner, I want a code's redemption limit to hold under concurrent
    redemptions, so that a code allowed 10 uses is never used 11 times.
44. As the product owner, I want a period that has lapsed to stop granting its plan with no
    background job involved, so that a failed sweep can never leave someone on Pro forever.
45. As a future developer, I want a trial and a promo period to be told apart in the data, so
    that the AI quota ticket can give them different allowances.

## Implementation Decisions

**Schema**

- `subscriptions` is reshaped: one row per period, with `organization_id`, `plan_id`, `kind`
  (`trial` | `promo` | `paid`, CHECK), `period_start`, `period_end`, `promo_code_id` (nullable),
  `trial_creator_id` (nullable), `voided_at` and `voided_by` (nullable), `created_at`.
  `UNIQUE (organization_id)`, `status` and `renews_at` go. `paid` is in the CHECK so that the
  vPOS slice adds a writer, not a migration, but nothing writes it in this slice.
- **No overlap**, enforced by an exclusion constraint over
  `(organization_id WITH =, tstzrange(period_start, period_end) WITH &&)` on non-voided rows.
  It needs the `btree_gist` extension. The range is half-open, so a promo that starts at the
  exact moment a trial ends does not overlap it.
- **One trial per creator**: the trial row copies the organization's `created_by` into
  `trial_creator_id`, and a partial unique index on it `WHERE kind = 'trial'` covers voided rows
  too. A voided trial still counts as used.
- **One redemption of a code per organization**: a partial unique index on
  `(promo_code_id, organization_id)` where the code is set. A voided promo still counts.
- New `promo_codes` table: `id`, `code` (unique, stored upper-cased and trimmed), `plan_id`,
  `percent_off` (1–100), `duration_months` (≥ 1), `max_redemptions` (nullable = unlimited),
  `redemption_count`, `redeemable_until` (nullable), `disabled_at` (nullable), `created_by` (an
  operator's user id), `created_at`. A code may not name `free`.
- `users.is_operator boolean NOT NULL DEFAULT false`. It is set by hand (SQL or a script), never
  through the API.
- Live databases get this through one additive, idempotent script that is then mirrored into
  `create_table.js` / `drop_table.js` and deleted, per the documented workflow. `subscriptions`
  has never had a writer, so it is empty and its reshaping touches no data.

**Reading the plan**

- `planFor(organizationId)` answers with the name of the plan on the non-voided subscription
  where `period_start ≤ now < period_end`, else `free`. Because of the exclusion constraint there
  is at most one. No copy of the plan lives on `organizations` (ADR 0005).
- Gate 4 is unchanged: it reads the plan from the token, and the token gets it from `planFor`
  at mint and refresh.

**Subscription service** (new, beside the organization feature)

- `current(organizationId)` → `{ current, next, trialAvailable }`, where `current` and `next`
  are `{ id, kind, plan, periodStart, periodEnd }` or null. `trialAvailable` is true exactly
  when the organization has never had a subscription row and its creator has no trial row.
- `startTrial(actor, organizationId)` takes the organization row `FOR UPDATE`, re-checks
  availability and inserts a trial row lasting `BILLING.TRIAL_DAYS` (config, default 30) on the
  `pro` plan, starting now. Refusal is `CONFLICT` with `details.reason`
  `trial_unavailable`. The unique index arbitrates a race between two organizations of one
  creator; its violation maps to the same `CONFLICT`, never a 500.
- `redeem(actor, organizationId, { code, trial })`, all in one transaction:
  - lock the organization row;
  - normalize the code and look it up;
  - unknown, disabled, past `redeemable_until`, or used up → `VALIDATION_FAILED` with one
    message and `details.reason` `code_invalid` for all four;
  - `percent_off < 100` → `VALIDATION_FAILED`, `details.reason` `payments_unavailable`, before
    anything is written;
  - a current `promo` or `paid` period → `CONFLICT`, `details.reason` `promo_active`;
  - already redeemed by this organization → `CONFLICT`, `details.reason` `already_redeemed`;
  - a current trial and no `trial` choice → `VALIDATION_FAILED` naming the field;
  - `trial: 'keep'` starts the promo at the trial's `period_end`, and `trial: 'end'` shortens
    the trial's `period_end` to now and starts the promo now. Shortening is the only edit a
    period ever takes. With no current period it starts now;
  - the period lasts `duration_months` calendar months from its start;
  - the redemption is counted with a conditional update
    (`redemption_count < max_redemptions` or no limit), so the database arbitrates the limit.
    Zero rows updated means the code is used up (`code_invalid`).
- Trial start and redemption both return the subscription view and a **fresh session** minted
  through `sessionFor` for the caller and this organization, the same shape `POST
  /organizations` returns. Other members pick up the plan at their next refresh.

**API**

- `GET /organization/subscription`, gated on `tender:read`: every member reads it.
- `POST /organization/subscription/trial`, gated on `billing:manage` (owner only), not
  plan-gated, rate limited.
- `POST /organization/subscription/redeem` with `{ code, trial?: 'keep' | 'end' }`, gated on
  `billing:manage`, rate limited per user so that guessing codes is slow.
- **Operator routes** under `/api/v1/operator`, mounted on `authenticateOrgless` plus an
  operator gate. This extends the orgless allowlist, and the justification is written beside it:
  being an operator is a property of the user, not of any organization, and these routes read no
  tenant's private data. A refusal is `ROLE_FORBIDDEN`.
  - `POST /operator/promo-codes` creates a code. A duplicate code text is `CONFLICT`.
  - `GET /operator/promo-codes` lists codes with `redemptionCount`, `maxRedemptions`,
    `redeemableUntil` and `disabledAt`, using cursor pagination.
  - `DELETE /operator/promo-codes/:id` deletes a code that was never redeemed, otherwise sets
    `disabled_at`. The response says which happened.
  - `GET /operator/organizations/:id/subscriptions` lists that organization's periods, voided
    ones included.
  - `POST /operator/subscriptions/:id/void` sets `voided_at` and `voided_by`. It is idempotent.
- **Token**: an `op: true` claim when `users.is_operator`, read from the database at mint and
  refresh exactly as the role is, so that revoking operator access lands within one access-token
  lifetime. The operator gate reads the claim.

**Ending announcements**

- A daily sweep on the ALERTS queue, scheduled like the vault expiry sweep, finds non-voided
  periods ending within 3 days, and periods that ended since the last run, **with no non-voided
  period starting at their end**. It raises two organization-wide announcements through
  `AnnouncementService`: `subscription-ending` (three days ahead) and `subscription-ended` (on
  the day). Their dedupe subjects are `{subscriptionId}-ending` and `{subscriptionId}-ended`, so
  each period is announced once each way.
- The wording is in the third person and names the plan and the date ("The organization's Pro
  trial ends on 12 November"), never a person.
- Queue and job names are added as constants.

**Also in this slice**

- CLAUDE.md is updated where this makes it wrong:
  - bank transfer as the payment backbone;
  - the ՀՎՀՀ collected "only when the customer chooses to pay by invoice";
  - "No subscription writer exists yet … sending an invitation answers 402 for everyone";
  - `subscriptions` and `invoices` listed as having no writer.
- `seed.js` keeps the plans as they are; nothing in this slice renames a plan.

## Testing Decisions

**No automated tests are written in this slice.** There is still no test runner (one
devDependency, no `tests/`, no `npm test`), and adding one is not part of this work. This was
confirmed during the spec.

A good test here asserts what an outside client sees, meaning status codes, envelopes and
`details.reason`, and never which repository method ran.

When tests arrive, the seam is already decided, the same one F-05 chose:

- **One seam: the HTTP boundary.** The exported Express app is served on an ephemeral port and
  driven with the built-in fetch. The feature is mostly gates (owner-only, operator-only, trial
  once, no code on an active promo, payment refused below 100%), and a service-level test would
  pass while a viewer could still redeem a code over HTTP.
- **Time is controlled through data, not a fake clock.** A test inserts periods with past or
  near-future dates and asserts the 402 or 200 that follows.
- **One narrow exception at the database.** Insert two overlapping non-voided subscriptions for
  one organization directly and assert the exclusion violation. Do the same for a second trial
  row with the same `trial_creator_id`. A constraint that silently failed to be created would
  leave every HTTP test green.
- Prior art: F-05's spec (same seam, same exception for the one-owner index) and
  `notifications_dedupe_uq` / `source_payloads` for "the database arbitrates the race".

**Verification by hand** against the local `tendra` database, recorded in each ticket:

- start a trial, then see `pro` in the returned session and a 200 from an intelligence route;
- move the trial's dates into the past by SQL, refresh, and see `free` and a 402;
- redeem with `keep` and with `end` during a trial and check the resulting periods;
- the overlap and second-trial constraints refuse direct inserts;
- a code allowed one use is refused for a second organization;
- the operator routes return 403 for an owner who is not an operator.

## Out of Scope

- **Card payments, the bank vPOS adapter and the `PaymentProvider` interface.** These are the
  next slice. A code below 100% is stored and refused at redemption until then.
- **Bank transfer, VAT invoices and reconciliation.** These are ruled out, not deferred (ADR
  0005). The `invoices` table stays unwritten.
- **The AI quota** (trial lower than promo or paid). It is a separate ticket after this slice;
  this slice only makes the two kinds distinguishable.
- **A grace period.** Nothing fails to renew yet, so nothing needs one.
- **Collecting the ՀՎՀՀ.** This is decided with the vPOS slice, since a legal entity paying by
  card probably still needs a VAT invoice.
- **Re-enabling a disabled code, editing a code, and proration or upgrades mid-period.**
- **A frontend for either the organization settings or the operator console.** Both are API
  only, like the rest of the product.
- **Granting operator access through the API.**

## Further Notes

- The trial plan is fixed at `pro`. Today `PLAN_GATED` tells nothing above `pro` apart, so a
  `business` trial would grant nothing more. Revisit if the plans ever diverge.
- `planFor` returns a plan name only. The quota ticket will need the current period's `kind`
  too, and should read it from the same row rather than adding a second lookup.
- Sending invitations is gated at `pro`, so a trial or promo organization can invite colleagues.
  A lapsed one keeps its members but cannot invite more, which is the growth-gated,
  shrink-free rule F-05 set.
- The shared launch code should be created with a `redeemableUntil` and disabled when card
  payments open, or it is free Pro for anyone who finds it.
