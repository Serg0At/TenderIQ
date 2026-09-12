# 04 — The roster

**What to build:** Every member of an organization can see who else is in it and at what role. A
tenant is a company, and its own staff list is not a secret from its staff — so this reads at
ordinary member level, not behind user management.

**Blocked by:** 01 — the roster shows names.

**Status:** done

- [x] Every member can read the roster, including a viewer.
- [x] Each entry carries the member's name, email address, role and when they joined.
- [x] Ordering is stable and carries a tiebreaker, so paging cannot repeat or drop an entry.
- [x] A member of another organization cannot read this one's roster; the isolation is enforced in
      the repository by scoping on the organization, not by the caller.
