# 03 — Orgless becomes a legal state

**What to build:** Registration creates only a user. Someone holding no membership can sign in, holds
a real session that permits nothing, and is told specifically that the problem is having no
organization — not that their role is too low. From there they can create one or read the invitations
addressed to them, and nothing else.

See ADR 0001 for why there is no "kicked" membership state and why registration stops creating an
organization.

**Blocked by:** 02 — without a way to create an organization, removing it from registration would
leave new users permanently stranded.

**Status:** done

- [x] Registration no longer accepts or creates an organization, and still returns no tokens.
- [x] Login for a user with no membership succeeds and reports an empty list of organizations.
- [x] The session such a login mints carries no organization, no role and no plan, so every gate
      default-denies.
- [x] A gated endpoint answers a dedicated no-organization refusal (403), distinct from the role
      and tenant refusals, so a client can show the right screen.
- [x] An orgless session refreshes normally instead of being treated as a stolen token.
- [x] The only things such a session can reach are: create an organization, read and answer
      invitations, and log out.
- [x] Creating an organization from this state leaves the user working inside it immediately.
