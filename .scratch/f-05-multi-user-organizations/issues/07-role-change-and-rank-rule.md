# 07 — Role change, and who may act on whom

**What to build:** An owner or admin changes a member's role. Ownership is not among the roles they
can assign — it moves only by transfer. And user management gains a rank rule, because without one an
admin can evict the owner who pays for the account.

**Blocked by:** 06 — a second member has to exist for this to mean anything.

**Status:** ready-for-agent

- [ ] An owner or admin can change a member's role among the four non-owner roles.
- [ ] Setting a role to owner is refused as a validation failure, naming the transfer action —
      ownership is a hand-off, not an assignment.
- [ ] An admin cannot change the role of another admin or of the owner.
- [ ] An owner can change any member's role.
- [ ] The refusal reports that the role is insufficient rather than hiding the member's existence —
      the actor is looking at the roster and already knows they are there.
- [ ] A role change signs nobody out; the new role takes effect within one access-token lifetime
      because role and plan are re-read on every refresh.
- [ ] The change raises an organization-wide announcement written in the third person, since
      delivery has no per-recipient targeting.
- [ ] Changing a role does not require an entitled plan.
