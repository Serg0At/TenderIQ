# 01 — Schema foundation: display names, named role ids, and the one-owner index

**What to build:** A person in the product has a name rather than only an email address, and an
organization becomes physically incapable of holding two owners. Nothing else changes for a user —
this is the prefactor the rest of F-05 stands on, and it is free only while `memberships` is empty.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Registration collects a display name and stores it against the user.
- [ ] Role rows are keyed by the role's own name instead of a generated identifier, and seeding
      them stays idempotent and still reconciles removed permissions.
- [ ] A unique index over `memberships`, restricted to rows whose role is owner, makes a second
      owner membership in one organization impossible.
- [ ] Inserting a second owner membership directly against the database fails with a unique
      violation rather than succeeding.
- [ ] The full-schema migration produces this shape from scratch; since every table is currently
      empty, the change goes into that migration and is applied with a down/up rather than through
      the additive-script workflow.
