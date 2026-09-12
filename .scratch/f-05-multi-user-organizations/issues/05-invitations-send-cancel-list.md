# 05 — Invitations: send, cancel, and see what was sent

**What to build:** An owner or admin invites a colleague by typing an email address and choosing a
role. The answer is identical whether or not that address has an account, so the endpoint cannot be
used to find out who is a customer. The organization can see every offer it has sent and withdraw
one. Pending offers appear in the roster — but only to people who may manage members.

**Blocked by:** 04.

**Status:** done

- [x] An invitation names an email address and a role; owner is not an acceptable role, since there
      is only one owner seat and it moves by transfer.
- [x] The response is the same object for a registered and an unregistered address, produced from a
      single module-level constant rather than two branches.
- [x] Nothing is looked up when sending, so there is nothing to enumerate.
- [x] Re-inviting the same address updates the role in place rather than creating a second offer,
      with the database arbitrating rather than application logic.
- [x] Re-inviting an address that declined returns the offer to pending.
- [x] An invitation never expires — no credential travels in it.
- [x] The sender can list their organization's offers at pending, accepted and declined, and can
      cancel one.
- [x] Sending raises a notification whose subject is the invitation and which names no tender, so
      it delivers through the existing channels with no new channel work.
- [x] Pending invitations appear in the roster only for members who may manage users, each entry
      distinguishable from a member and carrying no name, no user and no joined date rather than
      fabricated ones.
- [x] A viewer can never see an invited address.
- [x] Inviting requires an entitled plan (pro and above); removal, role change, leaving and
      transfer deliberately do not, so a downgraded organization can still shrink.
- [x] **Known limitation while F-02 is open:** no writer exists for subscriptions, so every
      organization reads as free and this gate refuses everyone. Verify it by inserting a
      subscription row by hand; do not weaken the gate to make the demo work.

## Implementation notes

- **The invitee is not personally notified (spec story 29 is not met).** Delivery resolves
  destinations by organization and ignores `notifications.user_id`, and sending looks nothing up,
  so there is no way to reach the invitee's own chat or inbox without either an account lookup or
  posting into their *other* organizations' channels (a leak to their colleagues). The
  `team-invitation` notification is therefore an organization-wide announcement in the inviting
  organization — third person, naming the role and the sender, never the address. The invitee
  finds the offer through `GET /invitations` (06). Per-user delivery is out of scope in the spec.
- **An accepted offer is not reset by a re-invite.** Ending a membership (08) must clear the
  member's accepted invitation so a returning member can be invited again.
- The plan gate was verified with a hand-inserted `subscriptions` row, not by weakening it.
