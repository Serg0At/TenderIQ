Status: ready-for-agent

# F-02b · The checklist quota

A follow-up to `.scratch/subscriptions/spec.md`, found in the post-build review on 2026-11-01 and
grilled on 2026-11-04. The term Quota is in CONTEXT.md; ADR 0005 governs the subscriptions it
reads. Its tickets continue the same numbering in `.scratch/subscriptions/issues/`.

## Problem Statement

The AI bid checklist is the expensive feature: about $1.09 of model spend per generation, and
together with the planned document generator 97% of AI spend per customer
(`docs/AI_COST_MODEL.md`). Nothing limits it.

- Generating needs only the `bid:write` role permission. It is not plan-gated, so a `free`
  organization generates checklists as freely as a paying one.
- `force` re-reads an unchanged document and calls the model again. The only brake is that one
  job per pursuit may run at a time.
- A trial can be opened by any verified email, so the exposure grows with every sign-up.
- `QUOTA_EXCEEDED` exists in the error enum and nothing raises it.

There are no card payments yet, so there is no "buy more". An unlimited allowance is therefore
unlimited spend.

## Solution

Every organization gets a **quota**: how many checklist generations it may request in one
calendar month (Yerevan) of its current subscription. The quota is set by its plan, and a trial
gets less than paid Pro. Every accepted generate request spends one. When the quota is spent, a
generate request is refused with `QUOTA_EXCEEDED`, which says how many were used, the limit, and
when it resets. A new subscription starts its quota afresh, so moving from a trial to a promo
gives the promo's full quota at once. Every member can see the quota in the organization's
subscription view.

Two things stop a generation from wasting the quota:

- A tender with no stored invitation is refused up front, without counting. This is the
  commonest case, since most tenders have no stored archive.
- A refused request (already running, AI not configured, not found, quota spent) never counts.

## User Stories

1. As the product owner, I want checklist generations limited per organization per month, so
   that model spend has a ceiling while there is no way to charge for more.
2. As the product owner, I want a `free` organization unable to generate a checklist, so that
   the paid feature stops being given away.
3. As an owner of a `free` organization, I want to still read an existing checklist and add
   items by hand, so that losing a plan never loses my work.
4. As an owner on a trial, I want 10 generations a month, so that I can see the feature work on
   real tenders.
5. As an owner on Pro (promo or paid), I want 30 generations a month, so that I can cover the
   tenders a supplier realistically pursues.
6. As an owner on Starter, Business or Enterprise, I want 5, 100 or 300 a month respectively, so
   that the quota grows with the plan.
7. As a coordinator, I want to see how many generations are left before I press generate, so
   that I do not spend the last one on the wrong tender.
8. As a viewer, I want to see the quota too, so that I understand why a checklist was not
   generated.
9. As a coordinator, I want a refusal to tell me used, limit and when it resets, so that I know
   when to try again.
10. As a coordinator, I want a tender with no stored invitation refused at once with a reason,
    and without spending my quota, so that I am not charged for "nothing to read".
11. As a coordinator, I want a request refused because one is already running, because AI is
    unavailable or because the quota is spent to cost me nothing, so that a refusal never eats
    my quota.
12. As a coordinator, I want `force` to count like any other generation, so that the rule is
    simple: every accepted request is one.
13. As an owner moving from a trial to a promo, I want the promo's full quota at once, so that
    redeeming a code starts a fresh month of work.
14. As an owner whose promo starts mid-month, I want its full quota for the rest of that month
    and a fresh one on the 1st, so that the reset date is the same for everyone.
15. As an owner whose subscription lapsed or was voided, I want the quota to read 0, so that the
    gate matches the plan I am on.
16. As every member, I want the quota to reset on the first of each month in Yerevan time, so
    that "resets on 1 December" means the day I see on my calendar.
17. As the product owner, I want two generate requests racing for the last unit of quota to
    produce exactly one acceptance, so that the limit is a limit.
18. As the product owner, I want the price recommendation left outside the quota, so that the
    cheap, cached, already Pro-gated feature is not rationed.
19. As the product owner, I want the limits defined in one place in code beside the plan gates,
    so that changing a number is a reviewed decision, not an environment variable.
20. As a future developer, I want the document generator to be able to spend from the same
    quota, so that adding it needs no second mechanism.

## Implementation Decisions

**What counts**

- One generation is one **accepted** `POST /tracked-tenders/:id/checklist/generate`, the 202,
  `force` included.
- Refusals never count: 404, 409 (already in flight), 503 (AI not configured), 429 (quota spent),
  and the new up-front refusal for a missing invitation.
- What the job then finds (`unchanged`, `no_text`, an oversized document, a failure) does not
  give the unit back. A rare `no_text` still counts, and that is accepted.

**Up-front invitation check**

- Before counting, the generate path asks whether the tender holds a stored invitation document.
  This is the same lookup the extractor's `loadInvitationText` begins with, at the database
  level only, with no storage read.
- With none, it answers `CONFLICT` with `details.reason` `no_document` or `unsupported_document`
  (the extractor's own reasons). It enqueues nothing and counts nothing. The checklist row is
  left as it is.

**Recording and the window**

- A new private table records each accepted generation: `id`, `organization_id`, the tracked
  tender (composite foreign key on `(tracked_tender_id, organization_id)` to `tracked_tenders`,
  as the tenant-isolation rule requires; `ON DELETE SET NULL (tracked_tender_id)` so that
  deleting a pursuit does not refund its generations), the requesting user, and `created_at`.
  Only repositories touch it.
- **Used** = this organization's generations since the later of the first of the current
  calendar month in Asia/Yerevan and the current subscription's `period_start`. With no
  current subscription, the limit is 0 whatever has been used.
- **resetsAt** = the first of next month, 00:00 Asia/Yerevan, as UTC ISO-8601. Like the promo
  months, it is computed in SQL at a fixed time zone, so a GMT database and an Asia/Yerevan one
  agree.
- **Limit** is a code constant beside `PLAN_GATED`, keyed by plan name with a trial override:
  `free` 0, trial 10, `starter` 5, `pro` 30, `business` 100, `enterprise` 300. A plan name with
  no entry is 0, which fails closed.
- The limit is read from the current subscription (`subscription.repo.js#current` with its kind)
  at request time, never from the token. The token's plan can be up to one access-token
  lifetime stale, and spend must not be.

**Enforcement**

- Generate takes the organization row `FOR UPDATE`, reads used and limit, refuses
  `QUOTA_EXCEEDED` (429) with `details: { used, limit, resetsAt }` when `used >= limit`, and
  otherwise inserts the generation row. It enqueues the job only after that transaction commits.
  The lock serializes two requests for the last unit, the same choke point trial and redemption
  use. There is no constraint to arbitrate a count, so the lock is the arbiter.
- Order: role gate → tracked tender found → AI configured → already in flight → invitation
  stored → quota (count and record) → enqueue. Everything before the quota step is a free
  refusal.
- If enqueueing fails after the commit, the unit stays spent and the request answers 500, the
  same honesty trade the announcement path makes. A retry counts again. This is rare and
  accepted.

**Visibility**

- `GET /organization/subscription` gains `quota: { used, limit, resetsAt }`, readable by every
  member (`tender:read`).

**Docs**

- `docs/API_REFERENCE.md` covers the generate endpoint's new refusals and the subscription
  view's `quota`.
- `docs/AI_COST_MODEL.md` § *Quota design sketch* is updated to what was built: the trial line
  and the window.
- CLAUDE.md § *Subscriptions* gets one bullet. CONTEXT.md already has Quota.

**Schema**

- Straight into `create_table.js` and `drop_table.js`. No add-script and no Neon step.

## Testing Decisions

- **No test runner is added**, the same as the subscriptions spec. Verification is by hand
  against local `tendra`, recorded in each ticket.
- **One seam: the HTTP boundary.** A good test asserts only what a client sees: 202, 409 with
  its `details.reason`, 429 with `used`, `limit` and `resetsAt`, and the subscription view's
  `quota`. It never asserts which repository ran.
- **Time is controlled through data**: generation rows and subscriptions inserted with past
  dates (last month's generations do not count; a period starting this month resets used).
- Hand cases that must be shown:
  - a `free` org → 429 with limit 0;
  - a trial org's 11th generate this month → 429;
  - a trial → promo (`end`) → full 30 at once;
  - a tender with no invitation → 409 `no_document` and used unchanged;
  - an in-flight 409 → used unchanged;
  - two concurrent generates at used = limit − 1 → exactly one 202.
- Prior art: the subscriptions tickets' verification tables, and F-05's HTTP-boundary seam.

## Out of Scope

- **Sharing one extraction across organizations** (AI_COST_MODEL cost lever #1). A cache hit
  from another organization will need its own rule about counting when it is built.
- **Buying extra generations, overage billing, metering.** There are no payments.
- **Quota for the price recommendation**, and for features not yet built, except that the
  document generator is expected to spend from the same quota when it arrives.
- **Per-user quotas.** The quota belongs to the organization.
- **Warning before the quota runs out** (an announcement at 80%).
- **Refunding a unit when the job finds nothing to do.**

## Further Notes

- Moving from a trial to a promo with `end` mid-month gives the promo's full 30 even if the
  trial's 10 were spent the same day. That is the decision: a new subscription is a fresh quota.
  Because promo codes are issued by the operator, this is not an abuse path.
- Ticket 07 (a trial claim survives its organization) closes the other trial-abuse path the
  review found. Without it, deleting and re-creating an organization would also mint a fresh
  trial quota.
