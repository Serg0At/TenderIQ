# 08 — Removal, leaving, and ending one organization's sessions

**What to build:** An owner or admin removes a member who has left the company, and any member can
leave an organization they no longer work with. These are two different acts with two different
gates — leaving needs no permission at all, removal needs user management plus the rank rule — so
they are two endpoints, never one handler asking "is this me".

Ending a membership must end that organization's sessions without touching the person's sessions
elsewhere, which is what the per-organization refresh index is for.

**Blocked by:** 07, 03.

**Status:** done

- [x] An owner or admin removes a member, subject to the rank rule from 07.
- [x] Any member can leave, with no permission required.
- [x] The sole owner can neither be removed nor leave; the refusal names the way out — transfer
      ownership, or delete the organization.
- [x] Removal deletes the membership outright; no revoked or kicked state is retained (ADR 0001).
- [x] Ending a membership revokes that organization's refresh families only, leaving the person's
      sessions in their other organizations working.
- [x] A removed member who belonged nowhere else lands in the orgless state from 03.
- [x] The removed member's alert destinations are left alone, so the announcement reaches them —
      this is how they find out which organization removed them. An owner can revoke those
      destinations separately.
- [x] Documents, tracked tenders and bids the removed member created stay with the organization.
- [x] Removal raises an organization-wide announcement in the third person.
- [x] Removing a member does not require an entitled plan.

## Implementation notes

- Ending a membership also deletes the member's `accepted` invitation for that organization, so a
  re-invite creates a fresh offer (tickets 05 and 06 depend on this).
- A removed member's refresh families for the organization are revoked, but their current access
  token is stateless and keeps working until it expires — accepted, as CLAUDE.md records.
- Sessions minted before the per-organization index existed are not in it; `refresh()` still
  refuses them because the membership is gone.
- Leaving raises no announcement (story 52 names role changes and removals only).
