# 05 — Invitations: send, cancel, and see what was sent

**What to build:** An owner or admin invites a colleague by typing an email address and choosing a
role. The answer is identical whether or not that address has an account, so the endpoint cannot be
used to find out who is a customer. The organization can see every offer it has sent and withdraw
one. Pending offers appear in the roster — but only to people who may manage members.

**Blocked by:** 04.

**Status:** ready-for-agent

- [ ] An invitation names an email address and a role; owner is not an acceptable role, since there
      is only one owner seat and it moves by transfer.
- [ ] The response is the same object for a registered and an unregistered address, produced from a
      single module-level constant rather than two branches.
- [ ] Nothing is looked up when sending, so there is nothing to enumerate.
- [ ] Re-inviting the same address updates the role in place rather than creating a second offer,
      with the database arbitrating rather than application logic.
- [ ] Re-inviting an address that declined returns the offer to pending.
- [ ] An invitation never expires — no credential travels in it.
- [ ] The sender can list their organization's offers at pending, accepted and declined, and can
      cancel one.
- [ ] Sending raises a notification whose subject is the invitation and which names no tender, so
      it delivers through the existing channels with no new channel work.
- [ ] Pending invitations appear in the roster only for members who may manage users, each entry
      distinguishable from a member and carrying no name, no user and no joined date rather than
      fabricated ones.
- [ ] A viewer can never see an invited address.
- [ ] Inviting requires an entitled plan (pro and above); removal, role change, leaving and
      transfer deliberately do not, so a downgraded organization can still shrink.
- [ ] **Known limitation while F-02 is open:** no writer exists for subscriptions, so every
      organization reads as free and this gate refuses everyone. Verify it by inserting a
      subscription row by hand; do not weaken the gate to make the demo work.
