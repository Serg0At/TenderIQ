# 06 — Invitations: accept and decline

**What to build:** An invitee sees the offers addressed to them, from any company, and answers.
Accepting adds a membership without disturbing the ones they already hold — joining a new client must
never cost someone an old one.

**Blocked by:** 05, 03.

**Status:** done

- [x] An invitee can list the offers addressed to their verified address, across every organization.
- [x] An offer sent to an address before it had an account is matched once that address registers
      and verifies.
- [x] Accepting adds a membership at the invitation's role and never moves or removes an existing
      one.
- [x] An invitee who already belongs to an organization stays working where they were; moving to
      the new tenant remains a deliberate switch.
- [x] An orgless invitee is working inside the new organization immediately after accepting, with
      no second call and no re-login.
- [x] Declining records an answer the sender can see, rather than leaving them with silence.
- [x] Someone previously removed and then invited back returns at the new invitation's role, not
      the role they used to hold.

## Implementation notes

- The last criterion (re-joining at the new role) holds at accept time; a *real* returning member
  also needs ticket 08 to clear their old accepted invitation, since a re-invite leaves accepted
  rows untouched (see 05). Verified here with the removal simulated directly in the database.
- Offers from an organization the caller already belongs to are hidden from `GET /invitations`,
  and accepting one by id is a 409 that leaves it pending.
- A re-accept of an already-accepted offer from an orgless session that still holds the membership
  returns a session again — recovery if the first response was lost after the commit.
