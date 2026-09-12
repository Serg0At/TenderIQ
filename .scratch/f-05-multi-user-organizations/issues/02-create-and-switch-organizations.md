# 02 — Create an organization, and switch between them

**What to build:** A signed-in user can create an organization, becomes its owner, and is working
inside it immediately. Someone holding several memberships — the consultant case — can move between
them, and the session for the organization they moved away from keeps working. One account cannot
mint organizations without limit.

This lands *before* registration stops creating organizations, so the product is never left with no
way to get one.

**Blocked by:** 01 — the one-owner index must exist before a second path creates owners.

**Status:** ready-for-agent

- [ ] Creating an organization makes the caller its owner, in one transaction.
- [ ] The response carries a full session for the new organization, so no second call and no
      re-login is needed to start using it.
- [ ] A user who already belongs to an organization can create another and move between the two.
- [ ] Switching organizations requires no permission — holding the membership is the authority.
- [ ] Switching starts a new refresh family rather than rotating the existing one, so the previous
      organization's session continues to work.
- [ ] A user may create at most three organizations; the fourth attempt is refused, counted from
      who created them.
- [ ] The creation route is rate limited.
