# Tendra

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
A supplier that uses Tendra, and the tenant boundary every private table is scoped by.
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

### Tenders and sources

**Tender**:
One run of a procurement procedure — one announcement with its own deadline, bidders and
outcome. A procedure cancelled and announced again is two tenders, even under the same
procedure code. An amended e-auction is one tender, although the site publishes the amendment
under a new tid (see **Superseded run**).
_Avoid_: Procurement, Procedure, Notice, Competition

**Superseded run**:
An e-auction page that an amendment replaced. eauction.armeps.am amends a tender by publishing
a new tid whose page names its predecessors («Աճուրդի սկզբնական հրավեր(ներ)»), and marks the
old page Փոփոխված. The new tid joins the old one's tender; the old one stays a link of that
tender, marked superseded, and is never read again. What makes it an amendment is that pointer,
never a shared procedure code.
_Avoid_: Re-issue, Old version, Duplicate

**Current link**:
The link of a tender, for one source, whose run has not been superseded: the page Tendra re-reads
and whose documents it fetches. Distinct from the **creating link** (`tenders.source_id`), which
after an e-auction amendment is a superseded run.
_Avoid_: Source ID (for the current page), Main link

**Procedure code**:
The code a buyer gives a procurement procedure (ծածկագիր), such as `ԵՔ-ԷԱՃԱՇՁԲ-26/11`. Shared by
every run of that procedure, so it names no single tender; it is how sources without a common
identifier are matched. `reference_code` in code.
_Avoid_: Tender ID, Reference, Tender number

**Submission channel**:
How a supplier submits a bid to a tender: by **e-auction** (live online price bidding), through
**ARMEPS** (one sealed electronic bid), or on **paper** (a sealed envelope delivered to the
buyer). A property of the tender, independent of its procedure type. Never "channel" alone: that
word already means where an alert is delivered (Telegram, email).
_Avoid_: Channel (alone), Submission type, Source, Platform, Procedure type

**Procedure type**:
The legal form of a tender's procedure: open, quotation, single source, e-auction or
restricted. A quotation can run on ARMEPS or on paper, so procedure type does not decide the
submission channel.
_Avoid_: Submission channel, Submission type, Purchase kind

**Source**:
A website Tendra reads tenders from: eauction.armeps.am, armeps.am, gnumner.minfin.am or PPCM.
One tender can be assembled from several sources, and one source can serve several submission
channels.
_Avoid_: Submission channel, Platform, Feed

**Addendum**:
A document a buyer adds to, replaces in or removes from a tender's published documents after
the announcement. An amendment of the tender even when no field moved, because it usually
changes what a bid must contain. Recognised by the buyer's files (name, CRC, size), never by
the archive's bytes.
_Avoid_: Attachment, New file, Re-issue (alone)

**Unmatched result**:
A bidder or award row from a source that could not be attached to exactly one tender — because
Tendra holds no such tender, or holds more than one with that procedure code. Kept with its
reason and counted, never guessed onto a tender and never thrown away. Two more reasons come from
paper invitations: a file Tendra cannot read (`unsupported_format`, no tender created) and a
tender created without a readable procedure code (`no_code`), which no result can be matched to.
_Avoid_: Orphan, Dropped row, Error

**Operator alert**:
A message to the people running Tendra about the health of the system — a missed tender, a
broken source — sent to the owner's private Telegram chat. Never reaches an organization.
_Avoid_: Alert (alone), Notification, Customer alert

### Discovery

**Saved search**:
One organization's standing description of tenders it wants to hear about — keywords, CPV
codes and a value range, under a name. The input to alerts, and one input to relevance.
_Avoid_: Profile, Search profile, Subscription, Watch

**Match**:
A tender clearing one saved search's threshold. Binary, and the only thing that decides
whether an alert fires.
_Avoid_: Relevance, Hit, Fit

**Relevance**:
How well one biddable tender fits one organization, graded and drawn from several signals — its
saved searches, its pursuit history and its public bid history. Orders a list; never decides an
alert, and never hides a tender.
_Avoid_: Match, Recommendation, Score (alone), Suitability

**Biddable tender**:
A tender an organization could still submit to — active or amended, with a deadline not yet
passed or no deadline at all. The only tenders relevance orders.
_Avoid_: Open tender, Live tender, Current tender

**Field**:
An industry an organization works in, chosen from a fixed list rather than typed — up to three
per organization, each covering a set of CPV divisions or groups. A weak relevance signal and a
discovery filter. `organizations.type` in code; the list is `src/libs/fields.js`.
_Avoid_: Type, Vertical, Industry, Sector, Category

**Purchase kind**:
Whether a tender buys goods, works or services, as the source labels it (Ապրանք, Աշխատանք,
Ծառայություն). A property of the tender, never of the organization.
_Avoid_: Procedure type, Tender type, Field, Category

### Intelligence

**Net price**:
An offer's value **without VAT** — the figure the auction ranks bidders on, what a supplier
enters, and the basis for every comparison between bidders: the gap from the winner, a lot's
price range, benchmark prices, the price recommendation, an organization's own bid. `*_net` in
code.
_Avoid_: Price (unqualified), Value, Bid amount

**Gross price**:
An offer's price **with VAT** — what the buyer pays, and the basis for every comparison with the
buyer's budget, which is itself gross: discount %, the over-budget check, buyer spend.
`*_price` and `awards.amount` in code. A non-VAT payer's net and gross prices are equal, so
comparing gross prices across bidders puts a VAT-paying winner up to 20% above a rival it beat.
_Avoid_: Final price, Total
