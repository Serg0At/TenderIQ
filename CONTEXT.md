# TenderIQ

Supplier-side bid intelligence over Armenian public procurement. This glossary fixes the
words the code and the docs must use for the same thing. It is a glossary only — decisions
live in [CLAUDE.md](CLAUDE.md), mechanics in [docs/](docs/).

## Language

### Identity and tenancy

**User**:
A person, identified by a verified email address and labelled by a display name. Holds no
data of its own — everything private belongs to an organization.
_Avoid_: Account, Member, Profile

**Organization**:
A supplier that uses TenderIQ, and the tenant boundary every private table is scoped by.
Carries two independent optional claims: a ՀՎՀՀ and a supplier identity.
_Avoid_: Account, Company, Workspace, Tenant, Client

**Membership**:
One user's belonging to one organization, at exactly one role. A user may hold several,
one, or none; a session names exactly one, or none.
_Avoid_: Seat, Assignment, Access

**Orgless**:
The state of a user holding no membership — freshly registered, or just removed. The same
state in both cases: signed in, nothing permitted.
_Avoid_: Unattached, Kicked, Pending user, Limbo

**Role**:
A named set of permissions a membership carries — `owner`, `admin`, `coordinator`,
`viewer`, `consultant`. Not a job title.
_Avoid_: Permission level, Access level, Group

**Owner**:
The one membership per organization that carries `billing:manage`. Exactly one exists at
all times, and it moves only by transfer.
_Avoid_: Admin, Account owner, Superuser, Creator

**Permission**:
A single fine-grained capability string (`bid:write`, `intelligence:read`) that a role
grants. Governs what may be done *inside* one organization, never which organization.
_Avoid_: Scope, Right, Grant

**Invitation**:
A standing offer from an organization to one specific email address, at a role fixed when
it is issued. Bound to that address; not transferable.
_Avoid_: Invite link, Invite code, Referral

**Roster**:
An organization's current members, with pending invitations merged in for those permitted
to manage them. Every member may read it.
_Avoid_: Member list, Team, Directory, Seats

**Removal**:
One member ending another's membership. Distinct from **Leaving**, which is ending your
own — different gates, different endpoints.
_Avoid_: Kick, Ban, Deactivate, Revoke

**ՀՎՀՀ**:
The Armenian eight-digit taxpayer number, unique across organizations but optional — an
organization holds one only once it has chosen to pay by invoice. `tax_id` in code, ՀՎՀՀ in
prose and in anything a user reads.
_Avoid_: TIN, VAT number, Company number, Registration number

**Supplier identity**:
The `parties` row an organization bids as — a deliberate human claim from a search, never
inferred from a name or derived from the ՀՎՀՀ. Its absence is why win/loss can be unknown.
_Avoid_: Supplier match, Party link, Company profile
