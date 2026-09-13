# 10 — Delete an organization

**What to build:** An owner who is the only member can close the account. This reverses the earlier
"organizations are never deleted" rule, and the reason that rule existed is the part that must be
built properly: the vault holds objects in storage that a database cascade cannot reach, so the
objects are erased first and the row second — the same ordering the vault already follows, which
leaves a failed erasure retryable instead of reporting success while the certificates survive.

Deleting is never a side effect of leaving: the one action that needs no permission must not be the
most destructive call in the API.

**Blocked by:** 08.

**Status:** done

- [x] Only the owner can delete the organization, and only when they are its sole member.
- [x] The organization's name must be echoed back in the request, so it cannot be destroyed by
      reflex.
- [x] Every vault object belonging to the organization is erased from storage before the row is
      deleted.
- [x] A failure partway through leaves the deletion retryable rather than half-done and reported as
      successful.
- [x] An organization with another member in it cannot be deleted.
- [x] Leaving never deletes anything.
- [x] After deletion the owner is in the orgless state if they belonged nowhere else.

## Implementation notes

- Purging goes by `vault_documents` rows of every status; the storage port has no list operation.
  An object whose row was already pruned by the daily pending-upload sweep (bytes arrived, never
  confirmed) is unreachable by this or any path — a pre-existing vault gap, not introduced here.
- Deletion is refused while a `pending` upload is younger than `VAULT.UPLOAD_URL_TTL_SECONDS`,
  because its presigned PUT could still deliver bytes after the purge.
- The transaction locks the organization row `FOR UPDATE` before re-checking vault keys and
  membership, so a concurrent document registration or accepted invitation waits on the foreign-key
  share lock instead of being cascaded away.
