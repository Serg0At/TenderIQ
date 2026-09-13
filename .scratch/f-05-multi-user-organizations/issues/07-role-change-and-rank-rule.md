# 07 — Role change, and who may act on whom

**What to build:** An owner or admin changes a member's role. Ownership is not among the roles they
can assign — it moves only by transfer. And user management gains a rank rule, because without one an
admin can evict the owner who pays for the account.

**Blocked by:** 06 — a second member has to exist for this to mean anything.

**Status:** done

- [x] An owner or admin can change a member's role among the four non-owner roles.
- [x] Setting a role to owner is refused as a validation failure, naming the transfer action —
      ownership is a hand-off, not an assignment.
- [x] An admin cannot change the role of another admin or of the owner.
- [x] An owner can change any member's role.
- [x] The refusal reports that the role is insufficient rather than hiding the member's existence —
      the actor is looking at the roster and already knows they are there.
- [x] A role change signs nobody out; the new role takes effect within one access-token lifetime
      because role and plan are re-read on every refresh.
- [x] The change raises an organization-wide announcement written in the third person, since
      delivery has no per-recipient targeting.
- [x] Changing a role does not require an entitled plan.

## Implementation notes

- **The rank rule also covers the role being granted.** The spec does not settle whether an admin
  may promote someone to admin; it was decided that they may not (and may not invite at admin
  either), because otherwise a compromised admin could mint the administrators it cannot remove
  (story 44). Only the owner grants `admin`.
- Every rank decision re-reads the actor's role from `memberships` rather than trusting the token,
  so a just-demoted admin cannot spend the remaining access-token lifetime managing people.
- The rank and owner-seat conditions are repeated inside the UPDATE's WHERE, so a concurrent change
  makes the update do nothing rather than land against a stale read.
