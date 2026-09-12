---
status: accepted
date: 2026-09-12
---

# Exactly one owner per organization, enforced by a partial unique index

An organization has exactly one `owner` — not "at least one" — and Postgres enforces it:
`CREATE UNIQUE INDEX memberships_one_owner_uq ON memberships (organization_id) WHERE role_id
= 'owner'`. A partial unique index needs a literal in its predicate, so `roles.id` becomes the
role's own name (`'owner'`, `'admin'`, …) instead of the CUID `ensureRoles` generates today.
Ownership therefore moves only through `POST /organization/transfer-ownership`, never through a
role change.

## Considered options

- **Enforce in the service** — count the organization's owners before promoting anyone. This is
  check-then-act: two concurrent promotions both count one owner, both pass, and the
  organization ends up with two. Rare, silent, permanent. Every comparable invariant in this
  codebase is handed to the database (`source_payloads`, `notifications_dedupe_uq`,
  `bids.locked`), and this one can be too.
- **"At least one owner", enforced in the service with `SELECT … FOR UPDATE`.** A weaker
  invariant that Postgres genuinely cannot express — there is no "at least one row" constraint —
  so it would have been the one rule living only in application code.
- **Leave `roles.id` a CUID and use a trigger.** Business logic hidden where nobody in this repo
  would look for it; the codebase has no triggers.

## Consequences

- The role-id change is free **today** and only today: the live database holds five `roles` rows
  and zero `memberships`, so nothing points at the old CUIDs. Once there are customers it is a
  foreign-key rewrite across every membership.
- Transfer must **demote the caller before promoting the target**, in one transaction. A unique
  *index* cannot be deferred, so the reverse order rejects the hand-off.
- `PATCH /organization/members/:userId` accepts four roles and answers `VALIDATION_FAILED` for
  `owner`, naming the transfer endpoint — ownership is a hand-off, not an assignment.
- The service still guards the *zero* side: a sole owner cannot be removed, demoted, or leave.
  The database owns the *two* side.
- An invitation is never issued at `owner`, for the same reason.
