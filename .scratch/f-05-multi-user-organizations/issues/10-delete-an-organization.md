# 10 — Delete an organization

**What to build:** An owner who is the only member can close the account. This reverses the earlier
"organizations are never deleted" rule, and the reason that rule existed is the part that must be
built properly: the vault holds objects in storage that a database cascade cannot reach, so the
objects are erased first and the row second — the same ordering the vault already follows, which
leaves a failed erasure retryable instead of reporting success while the certificates survive.

Deleting is never a side effect of leaving: the one action that needs no permission must not be the
most destructive call in the API.

**Blocked by:** 08.

**Status:** ready-for-agent

- [ ] Only the owner can delete the organization, and only when they are its sole member.
- [ ] The organization's name must be echoed back in the request, so it cannot be destroyed by
      reflex.
- [ ] Every vault object belonging to the organization is erased from storage before the row is
      deleted.
- [ ] A failure partway through leaves the deletion retryable rather than half-done and reported as
      successful.
- [ ] An organization with another member in it cannot be deleted.
- [ ] Leaving never deletes anything.
- [ ] After deletion the owner is in the orgless state if they belonged nowhere else.
