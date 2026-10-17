# 07 — Rank on what the team is working on, and what it already rejected

**What to build:** The ranking learns from the organization's own pipeline, which is the one
signal that improves every week the product is used.

Tenders resembling ones the team has **pursued** rank higher. Tenders resembling ones the team
looked at and **dropped**, or explicitly marked no-go, rank lower — telling the system "not for
us" has to mean something, or people stop telling it.

Tenders the organization is **already tracking** stay in their natural position, carrying their
pursuit state so the client can badge them. No boost: a list that promotes what you are already
working on tells you nothing you did not know, and hiding them would make work in progress
disappear from the view meant to show what matters.

Unlike the ledger in ticket 06, these signals are private tenant data, so every read is scoped to
the caller's organization by the repository.

**Blocked by:** 05.

**Status:** ready-for-agent

- [ ] A tender similar to ones the organization has pursued ranks above an otherwise equal tender.
- [ ] A tender similar to ones it dropped or marked no-go ranks below an otherwise equal tender.
- [ ] A dropped pursuit can push a tender into the weak band, but never removes it from the list.
- [ ] A tracked tender appears at its natural position and carries its pursuit state in the row.
- [ ] Tracking state is read for the caller's organization only, and never leaks across tenants.
- [ ] Pursuit history is subject to the same recency weighting as bid history, using the same
      configuration value.
- [ ] Reasons distinguish "your team pursued similar work" from "your team dropped similar work",
      so the client can explain a demotion as readily as a promotion.
- [ ] An organization with an empty pipeline ranks exactly as it did before this ticket.
