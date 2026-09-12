# 09 — Transfer of ownership

**What to build:** An owner hands the single owner seat to a named colleague in one deliberate act,
so they can leave the company without stranding the account. This is the only way ownership moves.

See ADR 0002: the unique index cannot be deferred, so the caller must be demoted before the target
is promoted or the organization's own hand-off is rejected.

**Blocked by:** 07.

**Status:** ready-for-agent

- [ ] Only the owner can transfer ownership; an admin attempting it is refused.
- [ ] The target must already be a member of the organization — not an email address, not an
      invitation.
- [ ] The caller becomes an admin and the target becomes the owner, in one transaction.
- [ ] The organization is never momentarily without an owner, and never momentarily with two.
- [ ] Nobody is signed out; both parties' new permissions take effect within one access-token
      lifetime. The outgoing owner therefore keeps billing management briefly — known and accepted.
- [ ] After the transfer the previous owner can no longer perform owner-only actions.
