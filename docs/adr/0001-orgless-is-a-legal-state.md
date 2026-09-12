---
status: accepted
date: 2026-09-12
---

# Orgless is a legal state, and registration creates no organization

`POST /auth/register` creates the user, the organization and the owner membership in one
transaction, and the account model decided on 2026-09-06 declared that "there is no orgless
state" — registration always makes an organization, a user cannot leave their last one, so
zero memberships is unreachable. Designing multi-user organizations (F-05) showed that
reasoning has a hole: **removal by someone else** reaches zero memberships regardless of what
the register endpoint does. A state that can be reached has to be a state the API can serve,
so orgless is now first-class — registration creates only the user, and `POST /organizations`
is restored as the single place an organization is born.

## Considered options

- **Refuse to remove a member whose only membership this is.** Symmetric with the rule on
  leaving and needs no new state — but it means a company cannot remove its own ex-employee
  from its own tenant, which is the feature.
- **A `kicked` status on `memberships`**, so the removed user still has a row and orgless stays
  formally unreachable. Rejected on two grounds. It does not actually avoid the branch: a
  kicked membership must never mint a token naming that organization, because `authenticate`
  copies `claims.org`/`claims.role` verbatim and `authorize` reads nothing else — so
  `sessionFor` still needs a no-organization path, and the status column buys nothing it was
  meant to buy. And the column itself is a hazard: `findMembership` is the one query that reads
  `memberships`, and a revoked-but-present row is one forgotten `where` away from restoring a
  removed employee's access in code that reads as correct.
- **Keep `organizationName` optional at register**, so a solo supplier still finishes in one
  step. Rejected because it leaves two paths that establish an owner membership and satisfy the
  one-owner index, and the second path is the one that rots.

## Consequences

- The onboarding token and its separate middleware stay dead. An orgless session is an ordinary
  session whose claims are `org: null, role: null`; `authorize` default-denies on a null role,
  and an explicit allowlist (`POST /organizations`, `GET /invitations` + accept/decline,
  `POST /auth/logout`) is what such a token can reach. `POST /organizations/join` stays deleted —
  invitations are the only way in.
- `refresh()` treats "no membership for `claims.org`" as token theft. It has to learn to re-mint
  an orgless session instead, or every orgless user is logged out every 15 minutes while trying
  to create the organization that would fix it.
- `NO_ORGANIZATION` joins the error enum as its own 403, for the reason `EMAIL_UNVERIFIED` is
  its own: different screen, and this one has buttons.
- Nothing records that a removed member was ever there. Accepted until phase 5 writes
  `audit_logs`; the rejected alternative was the status column above.
- A removed member learns *why* from the organization-wide announcement reaching their surviving
  `channel_subscriptions` row, not from the screen — with no tombstone there is nothing left to
  name the organization they were in.
