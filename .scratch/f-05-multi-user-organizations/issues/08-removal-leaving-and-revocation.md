# 08 — Removal, leaving, and ending one organization's sessions

**What to build:** An owner or admin removes a member who has left the company, and any member can
leave an organization they no longer work with. These are two different acts with two different
gates — leaving needs no permission at all, removal needs user management plus the rank rule — so
they are two endpoints, never one handler asking "is this me".

Ending a membership must end that organization's sessions without touching the person's sessions
elsewhere, which is what the per-organization refresh index is for.

**Blocked by:** 07, 03.

**Status:** ready-for-agent

- [ ] An owner or admin removes a member, subject to the rank rule from 07.
- [ ] Any member can leave, with no permission required.
- [ ] The sole owner can neither be removed nor leave; the refusal names the way out — transfer
      ownership, or delete the organization.
- [ ] Removal deletes the membership outright; no revoked or kicked state is retained (ADR 0001).
- [ ] Ending a membership revokes that organization's refresh families only, leaving the person's
      sessions in their other organizations working.
- [ ] A removed member who belonged nowhere else lands in the orgless state from 03.
- [ ] The removed member's alert destinations are left alone, so the announcement reaches them —
      this is how they find out which organization removed them. An owner can revoke those
      destinations separately.
- [ ] Documents, tracked tenders and bids the removed member created stay with the organization.
- [ ] Removal raises an organization-wide announcement in the third person.
- [ ] Removing a member does not require an entitled plan.
