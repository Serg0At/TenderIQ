---
status: accepted
date: 2026-11-01
---

# A subscription is a dated period, its state is read from the clock, and there is no bank-transfer rail

An organization's plan is held by `subscriptions` rows, **one row per period** — a trial, then a
promo period, then paid ones — each with `period_start` and `period_end`, so
`UNIQUE (organization_id)` goes. Only what a person did is stored: the row's kind (`trial`,
`promo`, later `paid`) and `void`. Whether a subscription is current or lapsed is **derived from
its dates**, never a status column, and `planFor` answers with the plan of the non-void row
covering now, else `free`. No copy of the plan (`current_plan`, `plan_valid_until`) lives on
`organizations`. And payment is by card through a bank vPOS once one is contracted — **bank
transfer against a VAT invoice is not a payment method**, though the reference spec makes it the
backbone.

## Considered options

- **One row per organization with a status machine** (`pending_payment → active → past_due →
  expired`, the task this replaced). `past_due` and `expired` are functions of `period_end` and
  the clock, so storing them needs a sweep to flip them, and a missed sweep leaves an
  organization on Pro forever — which is exactly what `planFor` did before this, checking
  `status = 'active'` and never a date. The same reasoning made vault expiry derived. A single
  row extended in place also overwrites the history of which period was granted by what.
- **Denormalize `current_plan` + `plan_valid_until` onto `organizations`** "so gate 4 stays one
  indexed read". Gate 4 reads no rows at all: `authorize` reads the plan from the token, and
  `planFor` runs only when a session is minted or refreshed. The copy would buy nothing and be a
  second answer to "what plan is this organization on" — the reason `notification_preferences`
  was removed.
- **Bank transfer + VAT invoice as the primary rail** (the spec's `technical/Payments
  Architecture.md`). Dropped by the product owner: launch gathers users on a trial and 100% promo
  codes while the vPOS contract is sorted out, then takes card payments. **ronda.am** (a local
  recurring-billing service, early access) was considered for cards and rejected.
- **Open access by config flag** instead of trial rows. Fewest lines, but every organization
  falls to `free` on the same day with no deadline it could have seen, the token says `free`
  while everything works, and plan gating goes untested until launch.

## Consequences

- **Subscriptions never overlap.** A code redeemed during a trial starts when the trial ends, or
  — the owner chooses — the trial is ended now. Ending it early shortens its `period_end`, the
  only edit a period ever takes; it is not voided, because a voided trial would let its creator
  start another. No code can be redeemed while a promo is current or scheduled. Non-overlap is what `planFor`
  relies on, so like every comparable invariant here it belongs to the database; the spec
  decides the constraint.
- **A trial claim belongs to the person, not the organization.** One trial per organization
  creator is recorded in `trial_claims`, keyed by the user and referencing no organization,
  because a trial row is deleted with its organization: a claim stored on that row would let a
  creator delete their organization and start a second trial in a new one. The claim outlives
  the organization it was made in, and a void, which touches only the subscription.
- **A promo code at 100% needs no checkout**, so it redeems straight into a period; anything
  below 100% is refused until card payments exist. Trial and promo are separate kinds so that
  their AI quotas can differ.
- **Codes are issued by an operator**, a platform-level identity this codebase did not have:
  `users.is_operator`, read at session mint like the role. `admin` stays a role inside an
  organization.
- **`organizations.tax_id` lost its collector.** CLAUDE.md says the ՀՎՀՀ is collected only when
  an organization chooses to pay by invoice, which no longer happens. When to ask for it (a card
  payer that is a legal entity probably still needs a VAT invoice) is decided with the vPOS
  slice; until then nothing asks, and the "already uses Tendra" collision never fires.
- A plan change from a trial start or a redemption reaches the actor through a fresh session in
  the response, and other members within one access-token lifetime.
