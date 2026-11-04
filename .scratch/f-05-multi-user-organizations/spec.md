# F-05 · Multi-user organizations — invite, member list, role change, remove

Board task: `FR-ACC-1 · Multi-user organizations — invite, member list, role change, remove (F-05)`.
Decisions recorded in CLAUDE.md § *Account and organization model*, ADR 0001 and ADR 0002.

## Problem Statement

Tendra is sold to companies but only works for one person. Today an organization comes into
existence in exactly one way — somebody registers — and from that moment there is no way to
put a second human inside it. A supplier with a bid coordinator, an owner who signs, and an
external consultant who writes the technical annex has to share one login between all three.

That costs money and correctness at once. Shared logins cost seats, and they destroy the only
record of who did what — which is the record phase 5 billing and the eventual audit trail both
depend on. It also blocks the consultant business entirely: a consultant works inside several
client tenants, and a user can currently hold only whatever single membership registration gave
them.

Everything private in the product is scoped to an organization — the vault, tracked tenders,
draft bids, saved searches, alert destinations. So "add a colleague" is not a settings screen;
it is the boundary the whole tenant model rests on.

## Solution

An organization becomes a place several people can be, with one person responsible for it.

An owner invites a colleague by email address at a chosen role. The invitee sees the offer
inside the product and accepts or declines it. Every member can see the roster — who is on the
team and at what role. Owners and admins can change a member's role and remove a member. Anyone
can leave an organization they no longer work with.

The organization has exactly one owner at all times: the person who holds billing. Ownership is
handed over as a deliberate act, never assigned like an ordinary role.

Because a person can now be removed, a person can now have no organization — so belonging to
none becomes an ordinary, supported state rather than an impossible one. Someone who has just
registered and someone who has just been removed land in the same place: signed in, able to
create an organization or accept an invitation, and permitted to do nothing else.

## User Stories

### Registration and the orgless state

1. As a new visitor, I want to register with just my email, password and name, so that I can get
   into the product without first having to decide what to call my company.
2. As a newly registered user, I want to sign in and see the product shell with everything
   locked, so that I understand I have an account but no organization yet.
3. As an orgless user, I want the API to tell me specifically that I have no organization rather
   than that my role is insufficient, so that the client can show me the two buttons that fix it.
4. As an orgless user, I want my session to keep working while I decide what to do, so that I am
   not thrown back to the login screen every few minutes.
5. As an orgless user, I want to create an organization and be immediately working inside it, so
   that I do not have to sign out and back in to use what I just made.
6. As an orgless user, I want to see invitations addressed to me, so that I can join the company
   that invited me instead of creating a duplicate of it.
7. As a user who was just removed from my only organization, I want to land in the same place as
   a new registrant, so that the product still works and I can join or create something else.
8. As a removed user, I want to find out that I was removed and by which company, so that the
   blank screen is not a mystery.
9. As the platform, I want a cap on how many organizations one account can create, so that a
   single free account cannot mint tenants in a loop.

### Creating and owning an organization

10. As a founder, I want the organization I create to make me its owner, so that I can pay for it
    and manage everyone in it.
11. As an owner, I want to be the only owner, so that there is never a question about who is
    responsible for the account.
12. As an owner, I want to hand ownership to a named colleague in one deliberate act, so that I
    can leave the company without stranding the account.
13. As an owner handing over, I want to become an admin rather than losing access, so that I can
    finish what I was doing.
14. As an owner, I want to be unable to accidentally give away ownership through the ordinary
    role-change screen, so that it cannot happen by mis-click.
15. As an owner who is the only member, I want to delete the organization deliberately, so that I
    can close an account I no longer need.
16. As an owner deleting an organization, I want to type its name back, so that I cannot destroy
    a tenant by reflex.
17. As an owner deleting an organization, I want the documents in the vault actually erased from
    storage, so that my certificates do not survive the account that held them.
18. As an owner, I want to be prevented from simply leaving an organization I am the only member
    of, so that I never leave behind something nobody can administer.

### Inviting

19. As an owner, I want to invite a colleague by email address at a role I choose, so that they
    arrive with the right permissions.
20. As an owner, I want the same answer whether or not the address has an account, so that the
    endpoint cannot be used to discover who is a customer.
21. As an owner, I want an invitation to a not-yet-registered address to survive until they sign
    up, so that inviting someone a minute before they register is not silently lost.
22. As an owner, I want re-inviting an address to update the role rather than create a second
    offer, so that correcting a mistake is one action.
23. As an owner, I want to re-invite someone who declined, so that a decline is an answer to one
    offer and not a permanent refusal.
24. As an owner, I want to cancel an invitation, so that an address I typed wrongly is not a
    standing offer to a stranger.
25. As an owner, I want to see every invitation my organization has sent and its state, so that I
    can tell "they have not answered" from "they said no".
26. As an owner, I want to be unable to invite anyone as owner, so that the single-owner rule
    cannot be broken from the invitation screen.
27. As an owner on a free plan, I want to be told clearly that inviting requires an upgrade, so
    that I know what to buy.
28. As an invitee, I want to see offers addressed to me from any company, so that I can join more
    than one client.
29. As an invitee, I want to be notified through my existing alert channel when I am invited, so
    that I do not have to be looking at the product to find out.
30. As an invitee, I want to accept an invitation and gain a membership without losing the ones I
    have, so that joining a new client does not cost me an old one.
31. As an invitee, I want to decline an invitation, so that the sender gets an answer rather than
    silence.
32. As an invitee who already belongs somewhere, I want accepting to leave me where I am working,
    so that my session does not jump tenants under me.
33. As an invitee who belongs nowhere, I want accepting to put me straight into the organization,
    so that I do not have to sign in again.
34. As someone who was removed and later invited back, I want to return at the role of the new
    invitation, so that being re-hired into a different job works.

### The roster

35. As any member, I want to see who else is in my organization and at what role, so that I know
    who to ask about a bid.
36. As any member, I want to see people's names rather than only their email addresses, so that
    the list is readable.
37. As an owner or admin, I want pending invitations shown alongside members, so that I can see
    who is about to join without opening another screen.
38. As a viewer, I want not to see the email addresses of people who have been invited but have
    not joined, so that the roster does not leak addresses to everyone in the company.
39. As any member, I want removed people to disappear from the roster, so that the list answers
    "who is on this team now".

### Roles and removal

40. As an owner, I want to change a member's role, so that a promotion or a reassignment is
    reflected in what they can do.
41. As a member whose role changed, I want to keep working without being signed out, so that a
    permission change does not cost me my draft.
42. As an admin, I want to manage the members below me, so that the owner does not have to do all
    the administration.
43. As an owner, I want an admin to be unable to remove or demote me, so that the person paying
    for the account cannot be locked out of it.
44. As an admin, I want another admin to be unable to remove me, so that a compromised admin
    account cannot clear out the administration.
45. As an owner or admin, I want to remove a member who has left the company, so that they stop
    having access to our tenders and documents.
46. As a removed member, I want to lose access to that organization quickly, so that the removal
    is real and not cosmetic.
47. As a removed member who belongs to other organizations, I want my other memberships
    untouched, so that being let go by one client does not sign me out of the rest.
48. As an owner, I want removing a member not to disturb the documents and bids they created, so
    that the company keeps its work.
49. As an owner, I want to be told when I cannot remove or demote someone and why, so that I know
    to transfer ownership first.
50. As an organization that has downgraded to a free plan, I want to still be able to remove an
    ex-employee, so that I do not have to pay again to close an access hole.
51. As a member, I want to leave an organization I no longer work with, without needing anyone's
    permission, so that I control my own membership.
52. As any member of the organization, I want to be told when someone's role changes or someone
    is removed, so that the team knows who is who.

### Working across several organizations

53. As a consultant, I want to hold memberships in several client organizations, so that I can
    work for more than one supplier.
54. As a consultant, I want to switch which organization I am acting in, so that I work inside
    the right tenant.
55. As a consultant, I want switching not to invalidate my session in the organization I left,
    so that I can move back and forth during a day.
56. As a consultant, I want switching to need no special permission, so that I can always use a
    membership I hold.

## Implementation Decisions

### Schema

- **`users.display_name`** is added, collected at registration.
- **`memberships` gains no status column.** Removal is a plain delete. The design and the
  rejection are recorded in ADR 0001.
- **`roles.id` becomes the role's own name** (`owner`, `admin`, `coordinator`, `viewer`,
  `consultant`) instead of a generated CUID, because the one-owner index needs a literal in its
  predicate. The role-seeding routine changes accordingly; it stays idempotent.
- **A partial unique index on `memberships`** over `organization_id`, restricted to rows whose
  role is owner. This is the exactly-one-owner invariant. ADR 0002.
- **`invitations`** is a new table: organization, email address, role, status
  (`pending | accepted | declined`), who invited, timestamps. `UNIQUE (organization_id, email)`
  makes a repeat invite an in-place update rather than a second offer. No expiry column — an
  invitation is a standing offer and no credential travels by email. The row survives an address
  that has no account and is matched when that address registers and verifies.
- **`organizations.created_by`** already exists and is now read, to enforce the per-user cap.
- Because the database currently holds zero rows in every table, schema changes go **directly
  into the full-schema migration** and are applied with a down/up, rather than through the
  additive-script workflow that exists to protect populated databases.

### Sessions and authorization

- **`sessionFor` gains a no-organization path.** With no membership it mints a session whose
  claims carry a null organization, null role and null plan, and the login response reports an
  empty organizations array. This replaces today's forbidden response, which treated the case as
  an invariant that should never fire.
- **The orgless allowlist** is explicit: create an organization, list and answer invitations, log
  out. Everything else default-denies on the null role. The client's blurring is presentation;
  the null claims are the enforcement.
- **`NO_ORGANIZATION` is added to the error enum** as its own 403, distinct from the role and
  tenant refusals, because it is a different screen with different buttons.
- **Refresh must re-mint an orgless session.** Today a refresh whose token names no live
  membership is treated as theft; for an orgless user that fires every time.
- **Creating an organization and accepting an invitation while orgless both return a full new
  session**, so the user is working immediately rather than waiting out a stale token. An
  invitee who already belongs somewhere is *not* moved — switching organizations stays a
  deliberate act.
- **`POST /auth/switch-org`** is built: re-mint against another membership, starting a new
  refresh family rather than rotating the old one, so the previous organization's session keeps
  working. No permission required.
- **Refresh families become addressable per organization.** The existing index is keyed by user
  alone, so revoking sessions for one tenant is impossible without signing the user out of all
  of them. Removal and leaving revoke that organization's families only. Role change and
  transfer revoke nothing — role and plan are already re-read on every refresh.

### Permissions

- **The rank rule** is added alongside `user:manage`: an owner may act on any member; an admin
  may act only on roles below admin, never on another admin and never on the owner. Refusals are
  role-forbidden rather than not-found, because the actor is looking at the roster.
- **`user:manage` is plan-gated at pro and above — for invitations only.** Removal, role change,
  leaving and transfer stay role-gated, so a downgraded organization can always shrink.
- **The roster reads at `tender:read`**, so every member can see the team. Invitation entries in
  the roster are visible only to `user:manage` holders.

### API contracts

- Role change accepts the four non-owner roles and refuses `owner` as a validation failure,
  naming the transfer endpoint. Ownership is a hand-off, not an assignment.
- Transfer of ownership is owner-only and demotes the caller before promoting the target, inside
  one transaction — the unique index cannot be deferred, so the reverse order rejects the
  hand-off.
- Leaving is its own endpoint, needing no permission; removal is a separate endpoint behind
  `user:manage` and the rank rule. They are never one handler branching on "is this me".
- A sole owner cannot leave. The routes out are transfer, or deleting the organization.
- Deleting an organization is owner-only, allowed only when the owner is the sole member,
  requires the organization's name echoed back, and purges vault objects from storage before
  deleting the row — object first, row second, as the vault already does.
- Invitations have three surfaces answering three different questions: offers addressed to me
  across organizations; offers my organization has sent, including declined ones; and the roster,
  which is who is on the team now.
- The invite response is a single module-level constant, identical whether or not the address
  has an account.

### Notifications

- An invitation raises a notification with no tender and the invitation as its subject, which is
  the shape the dedupe constraint was built for.
- Removals and role changes raise **organization-wide announcements written in the third person**
  ("Gevorg's role has been changed; he is now a consultant"). Delivery has no per-recipient
  targeting — the deliverable-destinations query filters by organization and channel and ignores
  the notification's user column — so a personally-addressed alert would require building
  per-user delivery first. That is deliberately out of scope.
- Removal does not revoke the leaver's alert destinations. Their rows survive and an owner can
  revoke them from the integrations surface. One consequence is load-bearing: this is how a
  removed member learns why their screen went blank, since nothing else names the organization.

## Testing Decisions

**No automated tests are written in this slice.** There is no test runner in the repository —
one devDependency, no `tests/`, no `npm test` — and adding one is not part of this work.

This is a knowing trade and the cost should be stated rather than discovered. F-05 is almost
entirely authorization logic: a rank rule, a plan gate, a null-claims default-deny, and a
database invariant that the whole ownership model rests on. Those are exactly the failures that
are invisible until a customer finds them, because the happy path looks identical whether or not
the gates hold.

When tests do arrive, the seam is already decided and needs no production change:

- **One seam: the HTTP boundary.** The app module exports an initialised Express app separately
  from the process that listens, so a test can serve it on an ephemeral port and drive it with
  the built-in fetch. Every test asserts status codes and response envelopes only.
- **Why this seam and not the service layer.** The feature *is* the four authorization gates,
  and those live in middleware. A test calling the service directly would pass while an admin
  could still evict the owner over HTTP.
- **One narrow exception.** The one-owner index should be proven at the database, by inserting
  two owner memberships directly and asserting the unique violation — an index that silently
  failed to be created would leave every HTTP test green.
- **Runner, when added:** the built-in node test runner and fetch, no new dependencies, matching
  a codebase that has no build step and no transform pipeline.
- **Prerequisite:** there is nowhere safe to run a suite today. The compose file has no Postgres
  service despite the command being documented, and the configured database is the remote one.

The same seam and harness would cover the three already-open test items on the board, of which
cross-tenant denial is the one this feature most directly puts at risk.

## Out of Scope

- **Billing and subscriptions.** No writer exists for subscriptions, so every organization reads
  as free and the pro gate on invitations will refuse everyone until that writer is built. This
  is a real sequencing dependency, not an oversight.
- **Audit logs.** Nothing records that a removed member was ever present. Accepted deliberately;
  the rejected alternative was a membership status column, whose one forgotten filter is a silent
  access leak.
- **Per-user notification delivery.** Announcements are organization-wide by design here.
- **Discoverability.** Whether an unattached user can find out that their company already has an
  account remains undesigned — an approval queue leaks that a company is a customer.
- **Shared alert addresses.** A team mailbox has no verified owner and would need the
  token-based linking flow; only a member's own verified address can be subscribed.
- **Merging two organizations** that turn out to be the same company by hand.
- **Deleting a user account**, as opposed to a membership or an organization.
- **A frontend.** Every story above is delivered as an API; the screens described are what a
  client would render.

## Further Notes

- The decisions here reverse two rules that CLAUDE.md previously stated in bold: that
  registration creates the organization in one transaction, and that organizations are never
  deleted. Both reversals are recorded in place, with reasons, in CLAUDE.md § *Account and
  organization model*, and the first in ADR 0001. Anyone reading the old rules in git history
  should treat this spec as superseding them.
- The role-id change is free only while `memberships` is empty. Once there are customers it is a
  foreign-key rewrite across every membership row, so it belongs early in the ticket order.
- `consultant` remains byte-identical to `coordinator` on purpose — it records that a member is
  external. Do not "fix" the duplication.
