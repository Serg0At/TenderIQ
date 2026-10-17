# 04 — Prefactor: one answer to "is this CPV code in my category"

**What to build:** Nothing a user can see. The CPV hierarchy rule — an exact code, then the same
3-digit group, then the same 2-digit division, each a weaker claim than the last — currently lives
inside the alert matcher, where it answers a yes/no question for one saved search. Relevance needs
the same rule, but graded: it has to know *how close* a match is, because an exact code is a much
stronger signal than a shared division.

Copying it would leave two definitions of what "medical" means, drifting apart the first time
someone fixes a bug in one of them. Extract it into a module both callers use: the matcher keeps
asking "does this hit?", relevance asks "how closely?".

Make the change easy, then make the easy change. This is the whole ticket.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] A single module answers how closely a tender's codes match a set of wanted codes, reporting
      the strength of the match (exact / group / division / none) rather than only a boolean.
- [ ] It stays pure: no database, no clock, no configuration read at call time.
- [ ] The alert matcher uses it and its behaviour is unchanged — a profile asking for a parent
      code still matches a child code, and a profile asking for a child code still does not match
      the parent.
- [ ] No alert fires or stops firing as a result of this ticket; the matcher's threshold, weights
      and output shape are untouched.
- [ ] Nothing else in the codebase still carries its own copy of the hierarchy rule.
