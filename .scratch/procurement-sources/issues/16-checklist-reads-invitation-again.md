# 16 — The AI checklist reads the invitation text again

**What to build:** A supplier who generates a checklist for a tender with a stored invitation gets
items extracted from that invitation, not `status: 'unavailable'`. This is a regression fix, found
in passing during ticket 05.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

Since `6f22fab` (per-tender file list and single-file downloads), `tenders.findDetail` selects
`tender_documents` as `id, kind, url, parsed, manifest`, without `storage_key`. The extractor's
`loadInvitationText` takes the invitation row from `findDetail` and reads `storage_key` from it, so
it always sees `undefined` and reports no text. Every checklist generated since then answers
"unavailable" no matter what is stored, which looks like the common "no document" path and so
raises no alarm.

- [ ] Confirm the regression first: on the local DB, generate a checklist for a tender that has a
      stored invitation `.txt`, and record that it currently comes back unavailable.
- [ ] The extractor gets the invitation's storage key from a repository method meant for it (for
      example, the invitation document of a tender), not from `findDetail`. `findDetail` serves
      the API, and an internal storage key must not be added to the detail response just to feed
      a worker.
- [ ] ARMEPS invitations (ticket 05, `kind` and archive shape may differ from e-auction's) are
      either read the same way or explicitly answer `unavailable` with a reason. The checklist on
      ARMEPS documents is a spec follow-up, so record which one applies.
- [ ] After the fix, the same tender produces items, each with verbatim evidence that passes
      `verifyEvidence`. Record the item count and one evidence span here.
- [ ] Grep for other readers of `findDetail(...).documents` that expect `storage_key`, and fix or
      list them.
- [ ] Checklists that were wrongly stored as unavailable are not silently left that way: list how
      many exist locally, and say whether regenerating them is a manual step or happens on the
      next request.
