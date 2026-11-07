# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tendra is supplier-side bid-intelligence SaaS over Armenian public procurement data. It scrapes
public tender notices, normalizes them into an OCDS-aligned model, and (eventually) turns that into
discovery, alerts, price benchmarks, and bid workflow. It is not a procurement platform and does not
replace ARMEPS. Users are **suppliers only** — the companies that bid.

Node.js ESM (`"type": "module"`), no build step, no TypeScript, no transpiler — files run as written.

**Strategic clock:** the procurement-law amendments creating a unified electronic platform are
planned to take effect **2027-01-01**, but the government's own OGP commitment (AM0058) puts the
platform's **testing in July 2027**, and no official source promises OCDS, a public API or migrated
history (`.scratch/procurement-sources/research.md`, checked 2026-10-18). The OCDS-aligned data
model still exists so that a new platform is a source adapter, not a rewrite — but do not plan
around scraping ending on a date. Scraping is the bridge for an unknown length of time, and it is
the system's primary architectural risk.

Product layers, in dependency order: **Discovery** (the hook) → **Intelligence** (the moat) →
**Bid workflow** (the glue) → **Post-award**. Build data and intelligence before polishing workflow.

## Commands

```bash
npm run dev              # API with nodemon (src/server.js)
npm run worker           # BullMQ worker process (src/workers/index.js)
npm run worker:dev       # ...with nodemon
npm run scheduler        # register repeatable sweep jobs in Redis, then exit
npm run migrate:up       # create the entire schema in one transaction
npm run migrate:down     # DROP the entire schema — not a step-back migration

docker compose up -d                       # redis + minio + bucket bootstrap
```

**There is no test runner.** `tests/` is empty and `devDependencies` has only nodemon. If a task
needs tests, the runner has to be chosen and added first — don't assume `npm test` exists. When tests
do arrive, the reference spec puts the coverage where the risk is: **cross-tenant denial**,
**intelligence correctness (`insufficient_data`)**, and a **listing-parser fixture test** — the one
that would catch a gnumner redesign before customers do.

**There is no linter or formatter configured.** Match surrounding style; the codebase is
2-space, single-quote, semicolon.

Migrations are hand-run scripts, not the Knex CLI. `migrate:up` runs `up()` over the whole schema in
one transaction and is not idempotent; `migrate:down` drops every table. A schema change means
editing `migrations/create_table.js` *and* `drop_table.js` — never adding a script (see
*Current state*, schema changes).

## Processes

Three deployable processes share one codebase and one dependency graph (modular monolith):

| Process | Entry | Role |
|---|---|---|
| API | [src/server.js](src/server.js) → [src/app.js](src/app.js) | HTTP, auth, tenant isolation, business logic |
| Workers | [src/workers/index.js](src/workers/index.js) | BullMQ processors; registers signal handlers and drains on SIGTERM |
| Scheduler | [src/queues/scheduler.js](src/queues/scheduler.js) | upserts repeatable jobs, then `process.exit(0)` |

The scheduler is a deploy step, not a daemon — BullMQ persists repeatable schedules in Redis, so the
cron keeps firing with nothing supervising it. Scheduler IDs derive from the source key, so
re-running replaces a schedule rather than stacking a second one.

Workers are split from the API deliberately: scraping is the fragile part, and a parser blowing up
on a redesigned page must not affect request handling.

## Hard boundaries

These two rules carry most of the architecture. Breaking either is the main thing to catch in review:

1. **Only repositories touch the database.** No Knex in services, controllers, or workers. The single
   Knex instance lives at [src/libs/knex.js](src/libs/knex.js); repositories import it as
   `../libs/knex.js`. Repositories own the import themselves and take an optional trailing
   `trx = db` argument — they never accept a connection as their first parameter, which is what
   leaks Knex into scripts.
2. **Only the storage port touches object storage.** Nothing imports the AWS SDK directly — go
   through [src/libs/storage/index.js](src/libs/storage/index.js), which lazily picks the `s3` or
   `local` driver from `STORAGE.DRIVER` and owns the deterministic key helpers.

Related invariants:

- **Every third party lives behind an adapter** in `src/libs/adapters/<kind>/` — never inline. One
  procurement source = one folder = one parser file to change when the site redesigns.
- **Tenant isolation is a repository responsibility.** Private queries are scoped by
  `organization_id` by the repository, not by the caller. **Every private table carries the
  column itself** rather than reaching an org through a join — a two-hop isolation check is one
  refactor away from being dropped. But a denormalised org id anchored to nothing is *worse*
  than none: it is a cross-tenant leak that reads as correct. So a child of a private table
  takes a **composite foreign key** on `(parent_id, organization_id)` referencing the parent's
  `UNIQUE (id, organization_id)`, and does not also carry a single-column FK to the parent.
  `bids` → `tracked_tenders` is the worked example; `checklists` and `checklist_items` carry it
  too, and `checklist_items` → `vault_documents` is the same shape one table across. Postgres accepted a mismatched row before this existed — it was verified, not
  theorised. One wrinkle worth knowing: a composite `ON DELETE SET NULL` nulls **every**
  column in the key, `organization_id` included, which fails its NOT NULL — so the optional
  attachment uses `ON DELETE SET NULL (vault_document_id)` (Postgres 15+). This was found by
  deleting an attached document, not by reading the manual.
- **Queue and job names are constants** in [src/queues/names.js](src/queues/names.js). Producers and
  consumers are in different processes, so a typo isn't a crash — it's a job that is silently never
  picked up.
- **Config reads `process.env` in exactly one place**:
  [src/configs/variables.config.js](src/configs/variables.config.js), which validates and refuses to
  boot on a bad value. Per-source scraping knobs live in
  [src/configs/sources.config.js](src/configs/sources.config.js).
- **Source text is data, never instructions.** Scraped content and tender PDFs must never reach the
  AI layer as prompt instructions.
- **Honest intelligence.** Below the comparable-count threshold, benchmarks return
  `insufficient_data` rather than a fabricated number.

## Ingestion pipeline

The moat. Everything else is a read model over what this produces. Detail:
[docs/SCRAPER_WORKFLOW.md](docs/SCRAPER_WORKFLOW.md).

```
scheduler --source.sweep----> ingest.fetch --listing.page--> (self, page N+1)
                                                           --tender.detail--> (self)
          --tender.refresh--> ingest.fetch --tender.detail--> (unsettled tenders, hourly)
                                         --> raw/ in object storage + source_payloads row
                                         --normalize.tender--> ingest.normalize
                                             --> tenders / parties / awards / public_tender_bids
```

**The listing writes no domain rows.** It is discovery only — it knows no buyer, no publish date and
no prices, so a listing-shaped tender could only reach the table behind a fabricated buyer. Detail
pages are the single writer. A finished tender's page additionally carries the `Գնառաջարկներ` bid
ledger (every bidder, rank, budget price, final offer), which is the sole public source of award and
supplier data — and the reason `tender.refresh` exists, since a tender settles long after it has
fallen off page 1 where the sweep can no longer see it.

What matters when touching it:

- **Idempotency is the design.** Dedupe anchors: `source_payloads` composite unique
  `(source, ref, hash)`, and `tenders.source_id` unique. A repeat sweep writes 0 rows and enqueues 0
  jobs. Storage keys are content-hash deterministic (`{prefix}/{source}/{ref}/{hash}.{ext}`), so a
  retried write is an overwrite, not a duplicate.
- **A unique-violation on insert is success, not failure.** The constraint exists so the database,
  not application logic, arbitrates the concurrent-worker race —
  `sourcePayload.repo.js:record()` returns `false` and the caller skips.
- **Raw payloads are kept forever.** When a parser improves, normalization replays from storage; the
  source is never re-crawled.
- **Pagination depth is a high-water mark, not `maxListingPages` and not a time window — one rule,
  one chain, every board.** Every listing is swept by `workers/listingChain.js`; a source supplies a
  *board* (page reader, watermark key, mark per notice, notice → job) and the module never branches
  on a source name. e-auction's mark is the tid (`sweep:tid:{source}:{slug}`): its listing table has
  **no publish-date column**, so a time-based rule compares against a field that does not exist (it
  did, silently, and made every sweep walk to the page cap). gnumner's is the publish datetime
  (`sweep:published:gnumner:{slug}`). Boards are newest-first, so continue to page N+1 only while
  the page's lowest mark is still above the watermark **and a next page exists** — never the site's
  reported page total. The watermark advances only when a chain terminates, so a sweep that dies
  mid-chain re-walks the gap rather than skipping it. **`maxListingPages` bounds a cold start only**
  (no watermark); with one, the chain walks until it reaches it, bounded only by
  `SCRAPER.MAX_LISTING_PAGES`, and warns if it stops short. e-auction once capped every chain at 40
  pages, which after a long outage committed the high mark over pages it never read — a permanent,
  silent hole. Because the walk is now unbounded by source, a page holding **nothing the chain
  has not read** throws before storing anything or marking the source healthy: that is a pager
  that did not advance, and a base URL that already contains the listing path produces exactly
  that (the site answers the malformed URL with page 1). **The board moves under a chain**
  (ticket 39): pages after the first go at `PRIORITY.CHAIN`, ahead of everything else on
  `ingest.fetch`, so a chain runs in seconds; a page repeating the previous page's tail (rows
  published meanwhile) skips it as read — newer than the oldest mark read, or tied with it
  (publish times are minute-precision) and named in `lowKeys` — and is no stall; and every page
  after the first re-reads the previous page *after* its own, so a row pulled up by another
  leaving the board (an amended e-auction) is still read. The reverse order loses that row, and
  before this the walk lost it with the watermark committed over it. Loading history is a deliberate backfill with its own page range.
  **One chain per listing at a time** (ticket 38): the sweep claims `{watermark key}:chain` before
  queuing page 1, every page re-arms its 60-minute TTL, and the page that ends the chain (or throws
  for the last time) deletes it; a sweep that finds it skips the listing and writes nothing. Only
  the holder may refresh or delete it, so a newer chain's marker is never released by an older one.
- **Never filter rows by deadline in a parser.** Expired tenders are the *most* valuable ones — prices,
  suppliers and awards exist only on finished pages. Filtering also puts a clock in a file that must
  stay pure, which breaks replay-from-storage and makes fixture tests rot. Filter in the query
  (`status`, `deadline_at` are columns); a row not scraped costs a re-crawl to recover.
- **Error type determines retry semantics.** `RateLimitedError` → `job.moveToDelayed` + `DelayedError`
  (being throttled must not burn an attempt). Zero *blocks* on an HTTP 200 → throw, because a
  "successful" sweep that ingests nothing is the #1 silent failure. Zero *usable rows* with blocks
  present is normal.
- **Freshness signal is the Redis key `sweep:ok:{source}`**, written on every successful page and read
  via `lastSuccessfulSweep(source)`. Do **not** use `max(source_payloads.fetched_at)` — unchanged
  content is deliberately never inserted, so that reports the last *change*, not the last *fetch*, and
  a quiet-but-healthy source would look dead.
- **The row fingerprint excludes the URL** ([src/workers/scraper.js](src/workers/scraper.js)) — if the
  source changed its URL scheme, every tender would flag as amended at once and re-notify every
  customer.
- **Politeness gate order: rate limit → HTTP.** There is no robots.txt check — no crawled host
  publishes one, and each serves its 404 as an HTML page rather than a 404 status, so the check was
  removed rather than kept as a permanent no-op. Adding a source that does publish crawl rules means
  reinstating it. Identity is always the declared bot UA; no UA rotation, no browser spoofing, no
  bypassing access controls.
- **TLS:** `gnumner.minfin.am` omits its intermediate cert. [certs/](certs/) supplies it via
  `SCRAPER.EXTRA_CA_DIR`. Never "fix" a chain failure with `rejectUnauthorized: false`.

## Layout

Layer-first today (`configs/ libs/ middlewares/ queues/ repositories/ utils/ workers/`), growing
toward feature folders under `src/features/`. The target tree and per-artifact placement rules are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — consult it before creating a new top-level folder.

Roughly: HTTP endpoint → `features/<feature>/{routes,controller}.js` · business rule → `service.js` ·
SQL → `repository.js` · site parser → `libs/adapters/source/<source>/` · any third-party call →
`libs/adapters/<kind>/` · background job → `workers/<worker>.js` calling existing services · table
change → `migrations/`.

Layering, one direction only: Router → Middleware → Controller → Service → Repository → Knex.
Controllers hold no branching business logic and no DB access; services know nothing about
`req`/`res`; workers duplicate no business logic — they call the same services.

## API conventions

Implemented — see `src/features/*/`. Follow the existing shape rather than inventing one:

- **Base path `/api/v1`**, plural resource nouns (`/tenders`, `/tracked-tenders`, `/vault-documents`).
  GET / POST / PATCH / DELETE. Time is ISO-8601 UTC. IDs are opaque CUID2 strings — never expose
  sequential internal IDs.
- **Envelope:** `{ data, meta }` on success, `{ error: { code, message, details } }` on failure. The
  `code` is a stable machine-readable enum; the `message` is safe for clients (no stack traces, no
  internal detail). Full context is logged server-side with a correlation ID.
- **Error codes:** `VALIDATION_FAILED` (400/422) · `UNAUTHENTICATED` / `TOKEN_EXPIRED` (401) ·
  `PLAN_UPGRADE_REQUIRED` (402) · `EMAIL_UNVERIFIED` / `ROLE_FORBIDDEN` / `TENANT_FORBIDDEN` (403) ·
  `NOT_FOUND` (404) · `CONFLICT` (409) · `RATE_LIMITED` / `QUOTA_EXCEEDED` (429) · `INTERNAL_ERROR`
  (500, with `details.ref`) · `DEPENDENCY_UNAVAILABLE` (503). Keep them in one enum; a DB
  unique-violation on ingestion maps to 409 or idempotent-upsert, never a 500. `EMAIL_UNVERIFIED` is
  its own 403 rather than a `ROLE_FORBIDDEN` because the client has to tell "you cannot do this"
  apart from "confirm your address and you can" — different screens, and only one has a button.
- **Pagination is cursor-based by default** (`?page[size]=20&page[cursor]=…` → `meta: { cursor,
  hasMore }`), page-based only where totals matter. Ordering always carries an `id` tiebreaker, or
  cursors break. Cap `page[size]`.
- **Authorization is four gates in order:** valid token → role holds the permission → resource's
  `organization_id` matches the token's org → plan entitles the feature. Roles are `owner`, `admin`,
  `coordinator`, `viewer`, `consultant`; permissions are fine-grained strings (`tender:read`,
  `bid:write`, `intelligence:read`, `billing:manage`). Default-deny. `intelligence:read` additionally
  requires an entitled plan (Pro+) regardless of role.
- **Validation happens at every boundary**, not just HTTP: request DTOs, job payloads on dequeue,
  scraped source data after normalization, and AI output against a strict schema. Whitelist and strip
  unknown properties. The reference says Zod; **this codebase uses Joi** — the layering is unchanged.

## Account and organization model

**Decided 2026-09-06, revised 2026-09-12, built 2026-09-13 (F-05, tickets 01–10).** The 2026-09-06 design kept registration's
create-user-and-organization transaction and declared orgless unreachable. **Both are reversed**, and
one observation reverses them: *removal by someone else* makes orgless reachable no matter what
`/auth/register` does. A state that can be reached has to be a state the API can serve, so it is now
a first-class one rather than an invariant that should never fire. Do not implement half of this; the
pieces are load-bearing on each other.

```
POST   /auth/register          { email, password, displayName }  -> 201, no tokens, no organization
POST   /auth/verify-email      { token }
POST   /auth/login             { email, password }  -> session + organizations[] (possibly empty)
POST   /auth/switch-org        { organizationId }   -> re-mint against another membership
POST   /organizations          { name, fields? }    -> organization + a fresh session for it

GET    /organization/members              roster; every member reads it
PATCH  /organization/members/:userId      role change — four roles, never owner
DELETE /organization/members/:userId      removal
POST   /organization/leave                leaving
POST   /organization/transfer-ownership   hand the single owner seat to another member
DELETE /organization                      delete — owner only, sole member only, name typed back
POST   /organization/invitations          invite an address at a role   (plan-gated: pro+)
GET    /organization/invitations          this org's offers: pending | accepted | declined
DELETE /organization/invitations/:id      cancel
GET    /invitations                       offers addressed to me, across organizations
POST   /invitations/:id/{accept,decline}
```

- **Orgless is legal, and it is the same state twice.** A user who has just registered and a user who
  has just been removed are indistinguishable to the API: no membership, a real session whose token
  carries `org: null` / `role: null`, and `organizations: []` in the login response as the only
  signal. There is no `memberships.status`, no "kicked" row, no tombstone — removal is a plain
  `DELETE`. A status column was designed and dropped: `findMembership` is the single query that reads
  `memberships`, and a revoked-but-present row is one forgotten `where` away from handing a removed
  employee their access back, in code that reads as correct.
- **The screen is never the enforcement.** `authorize` reads `role` and `plan` out of the claims, so a
  session minted from a membership that no longer exists would pass every gate in the system, and a
  blurred client would be decoration. The gating lives in the null claims. `authenticate` itself
  refuses an orgless token with `NO_ORGANIZATION`, so a route that authenticates and forgets to
  authorize still denies it; the allowlist is explicit and greppable — the routes mounted on
  `authenticateOrgless`: `POST /organizations`, `GET /fields` (its picker), `/invitations` (list, accept, decline),
  `POST /auth/switch-org` (the way out for a second device still holding an orgless session),
  `GET /auth/me`, and `/operator` behind `authorizeOperator` — there because an operator is a
  property of the user (`users.is_operator`, the `op` claim, read at mint and refresh like the
  role), not of any organization, and refused with `ROLE_FORBIDDEN` to every session without it.
  `POST /auth/refresh` and `/auth/logout` take no bearer token. An orgless refresh
  stays orgless even if a membership has appeared since — moving into a tenant is `switch-org`.
- **`NO_ORGANIZATION` is its own 403**, beside `EMAIL_UNVERIFIED` and for the same reason: the client
  must tell "your role cannot do this" apart from "you are not in an organization yet" — different
  screens, and this one has two buttons (create one, or check your invitations). `ROLE_FORBIDDEN` with
  a null role names the wrong problem.
- **An orgless session must refresh like any other.** `refresh()` looks up `findMembership(sub, org)`
  and treats a miss as theft; with `org: null` that fires on every orgless user, logging them out
  every 15 minutes while they try to create the organization that would fix it. It re-mints an orgless
  session instead.
- **Registration creates no organization**, and organizations are born in exactly one place. Making
  `organizationName` optional at register would leave two paths that establish an owner membership and
  satisfy the one-owner index, and the second one is the one that rots. The cost is one extra screen
  for a solo supplier; the gain is that sign-up stops being un-retryable — today a failed organization
  insert fails the whole transaction with the address already taken.
- **An organization has exactly one owner, and Postgres enforces it.** Not "at least one":
  `CREATE UNIQUE INDEX memberships_one_owner_uq ON memberships (organization_id) WHERE role_id =
  'owner'`. A partial unique index needs a literal, so `roles.id` is the role's own name rather than a
  CUID — which is free while `memberships` is empty and a foreign-key rewrite once it is not. The
  service still guards the *zero* side; the database arbitrates the *two* side, the same division as
  `source_payloads` and `notifications_dedupe_uq`.
- **Ownership moves only through `transfer-ownership`, never through a role change.** `PATCH
  /organization/members/:userId` takes the four non-owner roles and answers `VALIDATION_FAILED` for
  `owner`, naming the transfer endpoint: ownership is a hand-off, not an assignment, and a validation
  refusal says so structurally. Transfer is owner-only and **demotes the caller before promoting the
  target**, in one transaction — a partial unique index cannot be deferred, so the reverse order
  rejects your own hand-off.
- **Who may act on whom is a rank rule**, not just a permission. `user:manage` is held by `owner` and
  `admin` alike, so without it an admin can evict the owner who pays the bill. Owner acts on anyone;
  admin acts only on roles below admin — never on another admin, never on the owner. Refusal is
  `ROLE_FORBIDDEN`, not `NOT_FOUND`: the actor is looking at the member list and already knows the
  person exists.
- **Removal and leaving are separate endpoints because they are separate gates.** Leaving needs no
  permission at all — it is your own membership, the same reasoning that dropped `client:switch` —
  while removal needs `user:manage` plus the rank rule. One handler branching on "is this me" is how a
  `viewer` eventually discovers they can remove people.
- **You may always leave an organization that has someone else in it. To leave one that is only you,
  you must delete it.** A sole owner leaving would strand an organization with zero owners, which the
  index forbids; so `/leave` refuses, and the way out is `transfer-ownership` first or
  `DELETE /organization`.
- **Organizations CAN be deleted now, narrowly.** This reverses the 2026-09-06 "never deleted" rule,
  which existed because many tables CASCADE off `organizations` and `vault_documents` have objects in
  a bucket that Postgres cannot reach. That cost is paid rather than avoided: deletion is owner-only,
  allowed only when the owner is the **sole member**, requires the organization's name typed back, and
  **purges vault objects from storage first, row second** — the object-first-row-second ordering the
  vault already follows, which leaves a failed erasure retryable instead of reporting success while
  the certificates survive. It is never a side effect of `/leave`: the one endpoint that needs no
  permission must not be the most destructive call in the API.
- **A user may create at most 3 organizations** (`organizations.created_by` already records it and
  nothing reads it yet), plus a route rate limit. `POST /organizations` is reachable by any verified
  user on `free`, so uncapped it mints tenants — each with a vault prefix — in a loop, and the cleanup
  is the same storage purge above.
- **Ending a membership revokes that organization's refresh families, and only that organization's.**
  `refresh:user:<id>` is indexed per user, so `revokeAllForUser` would sign a consultant out of every
  client at once; removal and leaving need `refresh:user:<id>:<org>`. Be honest about what this buys:
  `refresh()` already fails closed when the membership is gone, so the revoke is Redis hygiene, the
  belt to that single query's suspenders, and the only way to end one tenant's sessions without
  touching another's. What it does **not** buy is a shorter window — a stateless access token cannot
  be recalled, so a removed member keeps working for up to 15 minutes either way.
- **A role change revokes nothing.** `refresh()` re-reads role and plan from the membership rather
  than copying them from the old token, so a demotion or a transfer lands within one access-token
  lifetime with nobody signed out — and signing a colleague out mid-task to deliver a permission
  change is worse than 15 minutes of stale permissions. The same 15 minutes is the honest cost on a
  transfer: the outgoing owner keeps `billing:manage` briefly, and the incoming one does not have it
  yet.
- **Removal does not touch the leaver's alert destinations.** `channel_subscriptions` rows survive
  with their `verified_at` intact, so an ex-member's private Telegram keeps receiving that
  organization's alerts until an owner revokes it — `revokeForOrg` is organization-scoped for exactly
  this, and `listForOrg` shows revoked rows so there is something to click. This is a knowing trade:
  auto-revoking would be tidier, but turning a channel off is organization-scoped while turning it on
  is caller-scoped, and an owner cannot re-link a chat for someone they re-hire. One accidental
  benefit — it is how a removed member learns *why* their screen went blank, since with no tombstone
  the screen itself cannot name the organization.
- **The roster is readable by every member.** `GET /organization/members` gates on `tender:read`, not
  `user:manage`: a tenant is a company, and its own staff list is not a secret from its staff. Pending
  invitations are **merged into the same list** but only for `user:manage` holders, each entry
  carrying `kind: 'member' | 'invitation'` with `userId`, `displayName` and `joinedAt` explicitly
  null rather than faked. An invitee's email address is therefore never visible to a `viewer`.
- **`users.display_name` exists and registration collects it.** Without it the roster is a list of
  email addresses.
- **Removals and role changes raise an organization-wide announcement, in the third person.**
  "Gevorg's role has been changed; he is now a consultant." Delivery has no per-recipient targeting —
  `listDeliverable` filters on organization and channel and ignores `notifications.user_id` — so any
  notification reaches every linked destination in the tenant. Writing these as company announcements
  rather than personal messages is what makes that honest; a personally-addressed alert would need
  per-user delivery built first, and that is phase 5's problem (a declined card is not a company
  announcement).
- **`organizations.tax_id` is the ՀՎՀՀ: unique, NULLABLE, and nothing collects it today.** It was
  to be asked only of a customer paying by invoice, and bank transfer against a VAT invoice is not a
  payment method (ADR 0005). Its one hard requirement is the Armenian VAT invoice, and a legal entity
  paying by card probably still needs one, so when to ask for it is decided with the vPOS slice. It
  is unverifiable — no source ingested today carries a *supplier's* tax number — so it was never
  evidence, only a consistently-claimed identifier. This wants a plain `UNIQUE`, whose default `NULLS DISTINCT` lets any
  number of orgs hold NULL — the exact opposite of `notifications_dedupe_uq`, and getting it backwards
  means the second TIN-less organization fails to insert.
- **De-duplication is therefore best-effort, and today it never fires.** The constraint turns a
  collision into "Shinarar LLC already uses Tendra — ask an admin there to invite you", but only
  between two orgs that both gave a ՀՎՀՀ, and nothing asks for one until the vPOS slice decides
  when to — so two tenants for one company can exist, and nothing stops them yet. Merging two tenants by hand is not an
  `UPDATE organization_id`: children carry composite `(parent_id, organization_id)` keys, and
  `vault_documents` have objects in a bucket.
- **The ՀՎՀՀ does NOT link an org to its supplier party today.** PPCM publishes every bidder's ՀՎՀՀ
  (ADR 0004), and since ticket 10 an ARMEPS bidder's `ppcm:bo:{ՀՎՀՀ}` party carries it — whether to
  use it for the claim is an open decision, and until it is made the rule below stands. Buyers get
  theirs from their invitation documents (e-auction's and ARMEPS's archive through
  `tender.repo.js:applyInvitationFacts`, paper's invitation at normalize; ticket 19).
  e-auction and paper supplier parties come from ledgers that carry names, ranks and prices and no
  tax number. Since ticket 11 an e-auction bidder gains its ՀՎՀՀ from PPCM where tender, lot and
  exact net match one ledger row, and party resolution is ՀՎՀՀ-first, so a PPCM bidder already
  seen on e-auction is the same party. A paper contract notice states the **winner's** ՀՎՀՀ
  (its last table, ticket 32), so a paper winner is keyed by it (`gnumner:bo:{ՀՎՀՀ}`) and reaches
  the same party too, on every lot of that notice, its losing bids included. Never across notices:
  a bidder with no number in its own notice stays keyed by its name, and **a name-keyed party
  never gains a ՀՎՀՀ** (`party.repo.js#nameKeyed`). Writing one onto it would hand every other
  notice's bidder of that name a stranger's identity.
  So the supplier identity (`supplier_identities`) stays a set of deliberate human claims from a
  search, and expecting the TIN to automate it is the obvious wrong guess. Storing it is still right: the 2027 OCDS platform
  identifies parties by `identifier.id`, which for Armenia is the ՀՎՀՀ.
- **Invitations are in-app; no email is sent.** The owner types an address and always gets the same
  answer — *"if that person is registered, they will get the invitation"* — as a **module constant**,
  not a string in two branches, for the same reason `/auth/forgot-password` has one: any difference in
  wording, status or shape makes the endpoint an account-existence oracle. Nothing is ever looked up,
  so there is nothing to enumerate. A user search would be strictly worse — a global directory of
  paying customers, readable by any free account. If search is ever wanted, invert it: an opt-in
  `discoverable` flag lists only people who asked to be listed.
- **The invitation row survives an address with no account.** It is keyed on email and matched when
  that address registers and verifies. Dropping it instead loses every invitation sent in the seconds
  before the invitee finishes signing up, and the deliberately uninformative response guarantees the
  sender never finds out.
- **`invitations` never expires, and re-inviting updates the role in place.** No credential travels in
  an email, so there is nothing to age out — the row is a standing offer, and an offer does not rot.
  `UNIQUE (organization_id, email)` makes a repeat invite idempotent, the database arbitrating rather
  than application logic, the same rule ingestion already follows — and re-inviting a `declined`
  address returns it to `pending`, since a decline is an answer to one offer, not a permanent refusal.
  The owner can **cancel**: a typo'd address is a live offer to a stranger until someone withdraws it.
  An invitation is never issued at `owner`; there is only one owner seat and it moves by transfer.
- **An invitation raises a notification, not a message.** `tender_id` NULL and `subject_id` = the
  invitation id — exactly the non-tender shape `notifications_dedupe_uq` was built for — so Telegram
  delivers it with no new channel work. Because delivery is organization-wide, it is a
  `team-invitation` announcement **in the inviting organization**, naming the role and the sender and
  never the address (a viewer's linked chat receives it). **The invitee is not personally notified**
  (spec story 29): that needs an account lookup on send or per-user delivery, both ruled out; they
  find the offer through `GET /invitations`. Three surfaces, three different questions: `GET /invitations`
  is *offers addressed to me* across every organization; `GET /organization/invitations` is *offers my
  organization has sent*, at `pending`, `accepted` or `declined`, for `user:manage` holders; the
  roster is *who is on this team now*. The overlap on pending rows is deliberate — a **declined**
  invitation is not a roster entry, and it is exactly what an owner needs to see.
- **Accepting an invitation adds a membership; it never moves one.** `memberships` is
  `UNIQUE (user_id, organization_id)` on purpose, and multi-org is the consultant case the
  `enterprise` plan already sells. The one exception is an **orgless** acceptance, which re-mints the
  session for the new organization — there is nothing to move away from. `POST /organizations` does
  the same, or the founder creates their company and then watches a blocked screen do nothing until
  the old `org: null` token expires.
- **Switching organizations needs no permission**, and `client:switch` is dropped from `consultant`. A
  permission gates what may be done *inside* a tenant; choosing which of your own memberships to act
  under is which tenant the question is even about, so gating it only lets a user hold a membership
  they cannot use. `POST /auth/switch-org` re-mints against a different membership and starts a **new
  refresh family** rather than rotating the old one — the previous org's token must keep working,
  since the user has not left that tenant.
- **`user:manage` is plan-gated at `pro` and up — but only for invitations.** It is the only thing
  enforcing `multi-user`, which is sold on `business` and appears in exactly one place in this
  codebase: a string in `seed.js` that nothing reads. Gating at `business` puts the whole pro → business price
  step in front of adding one colleague, which is where people share a login instead — costing the seat and
  corrupting the audit trail phase 5 needs. Removal, role change, leaving and transfer stay
  **role-gated only**: gating the growth direction sells the plan, while gating the shrink direction
  means a downgraded customer's only route to removing an ex-employee is to pay again.
- **A subscription belongs to an organization, never to a user.** (Its `kind` — trial, promo, paid —
  says how a period was granted, not whom it is for.) Gate 4 reads the plan of
  the session's organization (`sessionFor` → `planFor(membership.organization_id)`), so a user-level
  subscription would be invisible in the only place a consultant works — inside a client's tenant. A
  consultancy is itself an organization: it registers, buys a plan and works in its own tenant, which
  is all the intelligence layer needs, since benchmarks and competitor prices are computed over public
  award data and never touch a client's tenant. A membership in a client organization is required only
  for that client's *private* data — their vault, their draft bids — and there the client's plan
  governs, which is correct, because the client is who that value is delivered to.
- **`consultant` is a label, not a distinct permission set.** With `client:switch` dropped it is
  byte-identical to `coordinator`, and that is deliberate: it records that a member is external, which
  a member list and phase-5 `audit_logs` both want. Do not "fix" the duplication, and do not assume a
  capability difference exists — if the two ever diverge it must be for a stated reason. This also
  means `enterprise`'s seeded `consultant-mode` feature entitles nothing; its only real difference
  from `business` is `sla`.
- **Nothing records that a removed member was ever here.** With no tombstone and no `audit_logs`
  writer, "who did we remove last year" is unanswerable until phase 5 builds one. Known and accepted;
  the alternative was a status column whose one forgotten filter is a silent access leak.

Still to design: whether an unattached user can *discover* that their company already has an account —
an approval queue that leaks that a company is a customer, so it is deliberately not part of this
slice.

## Domain rules

Rules the code must enforce, independent of UI. The full list is in the reference spec's
`product/Business Rules.md`; these are the ones most likely to be violated by accident:

- **Dedupe by source ID.** A tender is uniquely identified by its ARMEPS tender ID. If a source ever
  reuses or rotates IDs, fall back to a composite key (buyer + subject + dates).
- **Amendments supersede but history is retained** — `version` + `is_latest`, readers filter on
  `is_latest`. Re-notification includes a change summary.
- **Never fabricate intelligence.** Below the comparables threshold, return `insufficient_data`.
  Benchmarks use only public award data and retain provenance.
- **Single source: a figure that measures competition excludes it unless the request opts in
  (`filter[includeSingleSource]=true`); a total counts it and carries a competitive /
  single-source split** (ticket 31). Competition means win rates, discounts from budget, bidder
  counts, rivals, price comparisons and benchmarks; totals are a buyer's tenders, spend and
  suppliers paid, and a supplier's contracts and revenue. The nightly profile rows follow the
  same line, and one tender's own ledger is never filtered (it is flagged `singleSource`). The
  filter is `tender.repo.js#competitiveOnlySql`.
- **Non-competitive / "wired-spec" flags are signals with evidence, never accusations.** This framing
  is mandatory — it is a legal and reputational constraint, not a wording preference.
- **No duplicate alert** for the same tender/event to the same organization — enforced by
  `notifications_dedupe_uq`, not by convention.
- **Expired certificates cannot be attached to a bid package** — enforced by
  `VaultDocumentService.assertAttachable`, whose one caller today is checklist attachment and
  whose second will be the bid package; **a bid in
  `submitted` state is a read-only locked snapshot** — enforced in `trackedTender.service.js`
  and by a `where locked = false` guard inside the UPDATE itself, so the loser of a concurrent
  submit is told rather than silently overwriting a submission timestamp.
- **A tenant's own win rate obeys the same threshold as a public benchmark.** Below
  `INTELLIGENCE.MIN_COMPARABLES` decided bids, `/tracked-tenders/performance` returns
  `basis: 'insufficient_data'` and a null rate. One decided bid is 0% or 100%, and both are
  noise wearing a percentage sign. Raw counts are still returned.
- **Publish only aggregated/anonymized statistics externally.** Private tenant data (bids, vault)
  never leaves its tenant.

Enum values constrained at the DB level by a CHECK: `tender.submission_channel ∈ {eauction, armeps,
paper}`; `tender_sources.role ∈ {discovery, detail, results}`; `tracked_tender.status ∈ {considering,
preparing, submitted, won, lost, dropped}`; `invitation.status ∈ {pending, accepted, declined}`; `subscription.kind ∈ {trial, promo, paid}`;
`channel_subscription.cadence ∈ {instant, daily}`; `alert_delivery.status ∈ {sent, deferred,
skipped, failed, held}`.
`tender.procedure_type ∈ {open, quotation, single_source, e_auction, restricted}` and `tender.status ∈
{planned, active, amended, closed, awarded, cancelled}` are pinned only by the Joi schema at the
normalizer boundary (`validations/schemas/tender.schema.js`) — there is no CHECK on either yet.
Nullable on purpose: `tenders.deadline_at` (some notices lack it), `awards.supplier_id` (void or
undisclosed), `vault_documents.valid_until` (non-expiring docs), `organizations.tax_id` (nothing
collects a ՀՎՀՀ yet) — features degrade rather than break.

## AI layer

The adapter and the first consumer exist: `src/libs/adapters/ai/anthropic.js` (the only file
that imports the SDK) and `services/priceRecommendation.service.js`. `aiExtractor.js` is still
empty. The rules below are enforced in that service and must hold for anything added:

- **Anthropic Claude API.** Use the current model IDs — `claude-opus-5`, `claude-sonnet-5`,
  `claude-haiku-4-5`. `ANTHROPIC_BASE_URL` optionally routes the SDK through a
  Messages-API-compatible gateway (OpenRouter is verified working: base URL
  `https://openrouter.ai/api` — **not** `.../api/v1`, the SDK appends `/v1/messages` itself —
  with `AI_MODEL=anthropic/claude-opus-5`). A gateway is only acceptable if it honours
  `output_config.format` json_schema; without it the extractor loses the schema-constrained
  output its safety design rests on, and the downgrade is silent. Verify before trusting a new
  one. The reference spec's `ai/Model Selection.md` names an older generation; treat
  its *routing logic* as current (cheap model for bulk classification, stronger model for hard or
  ambiguous extraction, escalate on low confidence) and its *model IDs* as stale.
- **Structured outputs, always.** Extraction and classification return schema-validated JSON — no
  regex over free text. Invalid shape → reject and repair, never persist.
- **Prompt architecture is a stable cached system prefix + volatile document text.** Never interpolate
  timestamps or IDs into the system prefix; it silently kills the cache. Verify with
  `cache_read_input_tokens`.
- **Tender documents are untrusted input.** The system prompt states that document text is data, not
  instructions, and the output is schema-constrained. A PDF saying "ignore previous instructions" is
  just text.
- **Check `stop_reason` before reading content**; on a refusal, degrade and flag rather than crash.
- **A throttled model call spends a retry attempt; it is not parked with `moveToDelayed`.** This is
  the one exception to ingestion's "being throttled must not burn an attempt". A `DelayedError`
  never increments `attemptsMade`, so a quota that does not reset loops outside the attempt budget
  in states that all count as live — for the checklist, a row stuck `pending` and every generate a
  409. On the last attempt `aiExtractor.js` records the throw as `failed` (`rate_limited`,
  `ai_unavailable`, `internal_error`), and `generate` refuses only while the *job* is live, never
  on the row's status alone.
- **AI output is advisory.** Low-confidence checklist items route to human review; nothing AI-produced
  is presented as legally authoritative.

## Quality targets

From the reference spec's non-functional requirements — these are what the design decisions are for:

| ID | Target |
|---|---|
| NFR-DATA-1 | New tenders ingested < 15 min after publication (the `SCRAPER.FRESHNESS_SLA_MINUTES` default) |
| NFR-DATA-2 | Coverage vs. source > 99% — this is why skipped notices are *counted*, not silently dropped |
| NFR-PERF-1/2/3 | Tender list/detail P95 < 1.5s · search P95 < 1s · intelligence P95 < 2s (precompute) |
| NFR-PERF-4 | Alert delivery < 5 min after ingestion |
| NFR-REL-1/3 | 99.5%+ uptime · RPO ≤ 24h |

Missed tenders are the #1 churn cause, which is why a zero-row sweep alerts rather than logs.
Localization matters: Armenian and Russian text and document encodings, AMD currency with USD
reference.

## Deliberate deviations

The reference specification says Prisma, Zod, and feature-first folders with a `container.js`
composition root. This codebase uses **Knex + hand-written migrations**, **Joi**, and layer-first
folders. These are decisions, not gaps — don't "fix" them. Reasoning is recorded in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Where reference docs say "Prisma client", read "Knex instance"; where they say "Zod schema", read
"Joi schema".

## Current state

Ingestion, the HTTP API, discovery, the intelligence layer, the **bid pipeline**, the **AI
checklist** and the **document vault** all run, and so do **multi-user organizations** (F-05)
and **relevance ranking** (FR-DISC-4). **Subscriptions** (F-02) are being built; card payments —
the rest of phase 5 — and phase 6 (post-award) do not exist.

**Subscriptions** (spec and tickets in `.scratch/subscriptions/`, ADR 0005, CONTEXT.md § *Plans and
subscriptions*):

- **A subscription is a dated period, one row each** — a trial, then promo periods, later paid ones.
  `planFor` answers with the plan of the non-voided row covering now (`subscription.repo.js#current`,
  the half-open `tstzrange(period_start, period_end) @> now()`), else `free`. **There is no status
  column and no sweep**: a lapsed period stops granting its plan by the clock alone. The lookup it
  replaced checked `status = 'active'` and never a date, so a period nothing flipped was Pro forever.
- **No copy of the plan lives on `organizations`.** Gate 4 reads the plan from the token and
  `planFor` runs only at mint and refresh, so a copy would buy nothing and be a second answer. The
  honest cost: a lapse reaches a session at its next refresh, up to one access-token lifetime late.
- **Periods never overlap, and the database says so**: `subscriptions_no_overlap_excl` (`btree_gist`)
  over `(organization_id, tstzrange)` on non-voided rows, so a promo starting the instant a trial
  ends is accepted and `current` is at most one row. `period_end > period_start` is a CHECK, because
  an empty range overlaps nothing and would slip past the exclusion. A voided row grants nothing and
  frees its time, but stays as the record of the grant — and still counts as "had a subscription".
- **Payment is by card through a bank vPOS once one is contracted. Bank transfer against a VAT
  invoice is not a payment method**, though the reference spec's `technical/Payments
  Architecture.md` makes it the backbone (ADR 0005). Until card payments exist, launch runs on a
  trial and 100% promo codes; `invoices` may never get a writer.
- **A trial claim outlives its organization.** One trial per creator is a `trial_claims` row keyed
  by the user, referencing no organization, inserted with the trial in one transaction — its
  primary key, not the organization row lock, settles two organizations of one creator. It used to
  be a column on the trial row, which `ON DELETE CASCADE`s with its organization, so deleting an
  organization handed its creator a second trial. A void touches the subscription, never the claim.
- **A checklist generation spends the quota** (ticket 08, `features/subscriptions/quota.service.js`).
  Every accepted generate, `force` included, is a `checklist_generations` row, written under the
  organization row lock before the job is queued — there is no constraint that can arbitrate a
  count, so the lock is the arbiter. The limit is `libs/permissions.js#CHECKLIST_QUOTA` (a trial
  10 whatever its plan; no entry is 0), read from the period covering now and never the token;
  the window opens at the later of the Yerevan 1st and that period's start, computed in SQL. A
  tender with no stored invitation is refused `409` with the extractor's own reason
  (`ChecklistExtractionService.invitationOf`) before the quota, and costs nothing.
- `GET /organization/subscription` answers `{ current, next, trialAvailable }` to every member.

**Relevance ranking** (`GET /tenders/relevant`, spec and tickets in `.scratch/relevance-ranking/`,
ADR 0003) — what building it decided, beyond the spec:

- **Relevance is not a Match.** `services/relevance.service.js#rankTenders` is pure and reads
  nothing the alert pipeline reads; the matcher and `MATCH_THRESHOLD` share only `libs/cpv.js`.
  Tuning relevance weights can never change which alerts fire.
- **One CPV rule, two questions.** `libs/cpv.js` answers *covers* (directional) and relevance's
  *closeness* (exact / group / division). The alert matcher, `filter[cpv]` and `filter[field]`
  all ask *covers*, the filters through its SQL twin `tender.repo.js#coversAnySql` — the two
  must move together — so a filter returns exactly what a saved search on the same code alerts
  on. `significantPrefix` strips
  trailing zeros but never below the 2-digit division: 30000000 covers division 30, not 30–39
  (ticket 26 — it once did, and sent false alerts). `libs/fields.js` refuses a prefix that is not
  a significant prefix, which is what lets the field filter share the rule.
- **Fields are `organizations.type`, a `text[]` of ids from `libs/fields.js`, ≤ 3.** That constant
  is the only definition of each field's CPV prefixes and refuses to load if two overlap. There is
  no `other`: optional fields mean "none of these" is choosing none.
- **No basis, no order.** With no field, saved search, bid history or pursuit, the endpoint answers
  `basis: 'insufficient_data'` and `missing`, never a ranking of zeroes.
- **What was shown is signed, not stored.** Each row carries an HMAC (`libs/relevanceReceipt.js`,
  `relevance:` domain prefix) over its score and reasons; `POST /tracked-tenders` records them only
  if the signature verifies for that org and tender. Nothing is written per page view.
- **Keyword hits are computed in SQL**, not by shipping lot names (~3,000 chars a tender, ~85% of
  the payload). The ranking query is ~20 ms server-side; from a developer machine to Neon the
  wall-clock is network.
- **The backtest is the verification**, not a test: `npm run relevance:backtest`. Before the
  archive backfill it showed 44% of real bids in the top 10 for suppliers with history (random
  6%); re-run it after ticket 10 to check `RELEVANCE_FULL_WEIGHT_MONTHS`.
- **Full weight lasts 24 months, by reasoning, not measurement.** Buyers procure on a yearly
  budget, so last year's bid is evidence for this year's round of the same tender; at 12 it
  was halved exactly then. Two months of ledger cannot separate windows — the backtest re-checks
  it once the archive exists.

**Team tasks were cut**, not deferred — the assignment/due-date feature was built and then
removed as unnecessary. Do not rebuild it from the reference spec's `product/Feature List.md`
(which still lists "Tasks, assignments, roles" as P1) without asking; that is a product
decision that has already been made.

- **Working:** `source.sweep` (watermark chain) → `tender.detail` → `normalize.tender` writes
  `tenders`, `parties`, `awards`, `public_tender_bids`. `tender.refresh` re-checks settled tenders
  hourly. `backfill.js` seeds the historical archive on its own queue and process.
- **All three submission channels run:** `eauction` = eauction.armeps.am, reverse auctions only
  (`procedure_type` always `e_auction`); **ARMEPS** — gnumner discovers it, armeps.am's CfT
  page creates it (`armeps` source, `procedure_type` `open`/`quotation` from the page; ticket 05);
  and **paper** — the invitation a gnumner notice uploads creates it (ticket 06, below). Paper
  results come from gnumner's contract-concluded notices (ticket 08, below). **Decided 2026-10-19 (ADR 0004): three submission channels — e-auction, ARMEPS and
  paper — assembled from four sources.** gnumner discovers ARMEPS and paper tenders, armeps.am
  details the ARMEPS ones, and PPCM and gnumner's contract `.docx` supply their results. A tender
  is one run, never a procedure code; every source a tender came from is a link on it
  (`tender_sources`, unique on `(source, external_id)`, written in `saveNormalized`'s transaction;
  `tenders.source_id` stays as the creating link until readers move over). Which tender an
  observation belongs to, and the tender's status, are decided only in the pure
  `services/resolution.service.js`; each adapter emits an observation
  (`eauction/observation.js`) and `workers/normalizer.js` merely orchestrates, so a new source
  is a parser, never a merge rule. Only a *result* is matched on procedure code — a detail page
  never is, which is what keeps a re-announcement a second tender. Anything
  that cannot be attached to exactly one tender is an unmatched result (`unmatched_results`), counted — and in
  production a missed tender will raise an operator alert (a later feature, live ingestion only).
  The e-auction source key was `armeps` until 2026-10-19 and is now `eauction`, so that `armeps`
  can mean armeps.am. Research and verification: `.scratch/procurement-sources/research.md`.
- **A paper tender is its uploaded invitation, keyed by the file's content hash** (ticket 06,
  `workers/paper.js`). The same file is sometimes uploaded twice under new paths, so the hash,
  not the path, is the detail link; each notice is a `paper:{path digest}` discovery link
  pointing at it. The file says nothing about when it was published, so the normalizer reads
  the notices too (`services/paperNotice.service.js`): the job's, and on a replay those already
  linked, re-parsed from their stored listing pages. **The deadline is the Yerevan calendar date
  of publication + N, at the stated time** — checked against the buyer's own listing close
  before it was written (34 of 36; N − 1 and working days fit none) — and is never moved off a
  holiday: buyers who mind already pick their N, and showing a day early is the safe error.
  Only a `.docx` (or one inside a `.zip`) holding the Armenian template is read; everything else
  is stored and counted as `unsupported_format` with no tender, on purpose, until the counts say
  which converter is worth adding — the comment at the format check in `invitation.parser.js` is
  addressed to the owner and holds the query. A tender with no readable code is created and
  counted `no_code`. `tenders.submission_address` holds where the envelope goes, and paper is the
  one source that writes `tenders.description` (the contract subject). A paper file never
  changes, so `refresh-gnumner` re-normalizes from storage the ones past their deadline, so they
  close. **One with no deadline closes at a ceiling** (ticket 37, `observation.js#
  undatedOpenUntil`): publication + 30 days for a quotation, 90 otherwise, about twice the
  longest seen. `deadline_at` stays null, since nobody stated it, and `deriveStatus` never
  reopens a `closed` tender on a null deadline. A deadline counted from when the invitation
  was *sent* is not read: gnumner does not show that day. The stated bid opening is not a
  fallback either, because it disagreed with the deadline in 8 of 60 files.
- **A re-posted paper invitation is an amendment of its run** (ticket 07). Paper names no
  predecessor, so for the paper channel alone a detail joins the stored tender of the same
  normalized code and buyer when the two overlap — the earlier still open, and not cancelled or
  awarded, when the later was published. **Dates decide, never the stored status or the order
  of arrival**: the newer file is the tender (an amendment that supersedes every other current
  file, under the row lock) and an older one read late — a sweep reads newest first — is a
  `superseded` link. A tender's `published_at` is its newest file's, which is what lets the lock
  catch a newer re-post committed in between (it throws, the retry resolves the file as older).
  `tender_sources.points_to` says which file each notice belongs to: one tender now holds the
  notices of several files, and a deadline counted from another file's notice is wrong.
  gnumner's **amendment listing** (`kind: 'amendment'`) carries Article 29 notices, and **a
  notice's content is not read** except for a code its title lacks (a readable `.docx`'s body):
  matched on that code across channels (one held only on e-auction/ARMEPS is skipped), it
  attaches whatever its format — `.doc`, `.rar`, `.pdf`
  — as a `tender_documents` row of kind `amendment`, beside the invitation and never compared
  with it, alerted as one added file. `unsupported_format` is only for files whose content must
  be read (invitations, contract notices).
- **A paper tender's results are gnumner's contract-concluded notice** (ticket 08,
  `contract.parser.js`, template 323-Ա, `paper.contract`): every bidder's net, VAT and total
  per lot, rejections, and the contract's winner, written with `source = 'gnumner'` through
  `tenders.recordResults` and `awarded` through `deriveStatus`. Its content is read, so `.doc`,
  `.pdf` and `.rar` are `unsupported_format` with the owner comment. Four things decided while
  building: the notice names no channel, so its code is looked up in every channel and one held
  only elsewhere is skipped before the format is asked (`channelUnstated`); rule 3 compares the
  notice's own **invitation date**, never its publication; the award is the one the contract
  names, at the winning bid's prices, never row order (and no rank is stored); and a lot is read
  only when the table places it — a «Հ/Հ» that looks like the lot number was shown not to be.
  `replaceLedger` replaces only the notice's lots, so two notices of one tender both stand. A
  notice is keyed by its upload path (`contract:{digest}`), so an unmatched one is re-read from
  storage when a paper tender of its code is created or a re-post joins one. A re-posted run
  matches on **any** of its files' publish dates (decided 2026-10-23): `published_at` holds only
  the newest, and `tender_sources` stores none — they are read back from the files' notices
  (`paperNotice.service.js#withRunPublications`), only for a run that holds a superseded file. **Most contract notices will never match**:
  the template says the invitation was "sent or published", most quotations are sent to invited
  suppliers and never reach gnumner, and ~780 notices (10-07 → 10-21) held one code from the
  published quotation listing. Ticket 08 records the counts.
- **A failure notice cancels an ARMEPS or paper tender only once every lot has failed** (ticket
  09, `failed.parser.js`, template 235-Ա Annex 13, `paper.failed`, ADR 0004). The template's
  table lists **the failed lots**, and its sentence says the whole procedure failed even when
  the table lists 13 of 39 — so the sentence is not read. Each notice is a `results` link with
  `observed_status = 'cancelled'` and `tender_sources.failed_lots`; the tender turns `cancelled`
  (`resolution.service.js#failureStatus`, through `deriveStatus`) when its notices' lots,
  together, cover `tender_lots` ∪ the ledger's lots. Partly failed → status untouched; no
  lots known → not cancelled yet (a wrong cancel is terminal and blocks the award); `awarded`
  never moves. **Either side may come first, and the second decides**
  (`services/failure.service.js#rederive`, under the row lock, from stored rows only): a
  notice linked, or a document set writing lots (`AddendumService.recordDocuments`, the one
  place lots are written) — so a notice read before the lots cancels the tender when they
  arrive, with nothing re-read or re-downloaded. The notice
  states no invitation date, so it matches the ARMEPS/paper tender of its code **announced
  before it and past its deadline when it was published, the latest** (a code is re-announced
  only after its run failed, and a live re-announcement is never cancelled by its
  predecessor's late notice); e-auction codes (held only on e-auction, or `ԷԱՃ` with no
  ARMEPS/paper tender) are skipped before the format is asked; unreadable files are `unsupported_format`; it never
  creates. One read before its tender existed is re-read when a paper or ARMEPS tender of its
  code is created, through the contract notice's path (`paper.js#queueResultRetries`, a
  `reason: 'retry'` job rebuilt from the stored listing page).
- **A result of a procedure that was never public is a result-only tender** (ticket 31, ADR 0004's
  second exception to "results never create"). `resolution.service.js#wasPublic` decides from
  facts only: an invitation of the code ever on the `open`/`quotation` listings
  (`listing_notices`, every entry of those listings, ingested or not, written by the listing chain) → public; single source (the code's `ՄԱ`
  marker or the notice citing article 23, never disagreeing) → never; otherwise only inside the
  **covered window** — the invitation's day ±1 strictly above every invitation listing's floor
  (`sweep:published:gnumner:{slug}:floor`, beside the watermark: a cold start's oldest notice,
  raised past any page-ceiling hole) and at or below its watermark, with no code-less notice
  published in that span → never; anything else unknown. Never public, with a code, an
  invitation date (rule 3 needs it to join a later notice), a buyer, a procedure type and an award: a `paper` tender, `awarded`, one `results` link, **no
  `match.tender` ever**. Every unmatched result records `procedure_type` and `was_public`, so
  the operator alert reads `no_candidate` **and** `was_public` — the rest is not a miss. Do not
  widen "never public" to a guess (a title's «ՄԱ գնման» wording, a date near the window): a
  wrong `false` hides a real miss and creates a tender that should not exist.
- **A code whose method marker `ՁԲ` runs straight into a digit is the same code with the dash**
  (ՄԿԻ-ԳՀԱՊՁԲ26/47 = ՄԿԻ-ԳՀԱՊՁԲ-26/47, ticket 07; 14 stored tenders are written that way). The
  title extractor reads it, and `normalizeCode` and its SQL twin `codeKeySql` put the dash back in
  that one position and nowhere else — the SQL with a capture and `\1`, never a `(?=`
  lookahead: knex reads that `?` as a binding and every code lookup throws.
- **armeps.am serves a different page on every request, and what is stored is canonical.** A
  fresh `jsessionid` in every link, a clock, a pager key, a calendar: `armeps/cft.parser.js#
  canonicalPage` strips exactly those, and the stripped page is both hashed and stored, so a
  key's hash stays the sha256 of its bytes and a re-fetch writes nothing. The session id
  contains `+`; a character-class regex left a fragment behind and re-stored 29 of 53 pages on
  the first refresh — match it up to the end of the path. The document ZIP is likewise built per
  download (fresh entry timestamps, a generated listing PDF), so its identity is
  `documents.js#documentSetHash` over the buyer's files, not the archive's bytes. armeps.am
  has no listing, so `tender.refresh` is per source (`REFRESHERS` in `workers/scraper.js`):
  for armeps it re-reads every *open* tender, because a deadline moves there without the
  gnumner notice changing. Buyers are keyed per source (`armeps:buyer:…`); a buyer that
  runs several channels is one party once its ՀՎՀՀ is known (next bullet but one).
- **PPCM is an ARMEPS tender's results** (ticket 10, `workers/ppcm.js`, `ppcm.results`). Its
  organized-procedures report is asked by procedure code (`refresh-ppcm`, every 2 h, each code
  at most daily, claimed in Redis) for ARMEPS tenders past their deadline, within 90 days, not
  cancelled, and **with a lot that has neither an award nor a recorded failure** — buyers file
  weeks late or never, and one lot's contract weeks before another's, so `awarded` (which comes
  with the first) does not stop the asking (decided 2026-10-27). A tender PPCM has not
  reported simply stays `closed` and a bid on it `not_found`. It spends armeps.am's rate budget
  (same host) at `PRIORITY.RESULTS`, behind live discovery. The answer is stored whole; each
  procedure in it (a code is re-announced, so procedures are told apart by announcement) goes
  through rule 3 — code, ARMEPS channel, announcement = publication day, opening = deadline day
  — and `ResultsService.record`, the path gnumner contract notices take. Decided while
  building: `participant_total_price` is **net** and no gross is invented for a bid;
  `contract_price` is the award's **gross** — what the buyer pays, and spend sums it — which on
  ~1 lot in 7 is a framework or partial-funds contract well below the offer. **A discount from
  the budget compares the winner's offer, never the contract** (decided 2026-10-27):
  `tender.repo.js#awardOfferSql` is the award's `amount` except on a PPCM award whose contract
  is not the winning net or net + 20%, where it is NULL — every discount figure (benchmark,
  buyer and supplier profiles, competitor prices) leaves that lot out and counts it
  (`discountExcludedLots`), and no gross is guessed. Its JS twin is
  `ppcm/observation.js#pricedAsOffer`; change both; `bid_rejected` is **not read**, it is
  `true` on winning rows; the report joins every contract of a procedure to a lot its winner bid
  on, so a lot naming several contracts keeps only the one priced at its winner's own offer
  (net or + 20%); with none it is not read at all, since its bids without an award would
  reconcile as every bidder's defeat. An unchanged answer is resolved again while the tender
  asked about holds no PPCM link, and codes are asked exactly as spelled (the filter is exact). Bidders are `ppcm:bo:{ՀՎՀՀ}` parties carrying `tax_id` — unless a
  party already holds that ՀՎՀՀ: **party resolution is ՀՎՀՀ-first, per-source id second**
  (`party.repo.js#upsert`, ticket 11), and two parties holding one ՀՎՀՀ fall back to the
  per-source id; a shared ՀՎՀՀ is reported when an attach creates it, never merged. Only a
  holder of the same role or `both` counts — a bidder is never folded into a buyer row by ՀՎՀՀ,
  nor a buyer into a bidder's. That path is bidders' only: a buyer never takes it (next bullet).
- **Buyers holding one ՀՎՀՀ are merged, by ՀՎՀՀ, never by name** (ticket 19,
  `party.repo.js#mergeBuyers`): tenders move to the holder with the most, the other's per-source
  id becomes an alias (`party_aliases`, which `upsert` resolves third) and its row is deleted.
  The alias is load-bearing: `buyer_id` is in the amendment hash, so a replay that re-created a
  merged-away buyer would re-alert every subscriber. Buyer with buyer only (`role = 'buyer'`).
  **The ՀՎՀՀ decides, a name can only stop it**: a group whose names differ by more than
  quoting and case is refused and reported, because a branch prints its parent's number (Yerevan
  State University and its Ijevan branch, 01506928) and telling a branch from a re-spelling is
  reading the name. A person's answer is `npm run buyers:merge -- --apply --confirm <ՀՎՀՀ>`.
  The source does not tell them apart either — every buyer's per-source id is its name's. The
  ՀՎՀՀ is the invitation's bank-guarantee form, field 11 «Շահառուի ՀՎՀՀ» (`libs/taxId.js`), on
  every Word document of a set: paper's from its invitation at normalize time
  (`upsertBuyer` resolves by per-source id only, fills that row, then merges — so the name veto
  holds on every path — before the tender is compared), an
  ARMEPS buyer's from its document archive, e-auction's from its own rule. Only .docx is read;
  PPCM states no buyer ՀՎՀՀ except through a by-name lookup, so it is not used.
  `npm run buyers:merge` (dry run by default) fills and merges from storage.
- **For an e-auction PPCM writes only the bidders' ՀՎՀՀ** (ticket 11,
  `services/bidderTaxId.service.js`): never a link, bid, award, status, rank or rejection.
  Awarded e-auctions with a bidder lacking one fill the room the ARMEPS asks leave in a batch,
  each code every `taxIdPollHours`. A ՀՎՀՀ attaches only when the tender (rule 3), the lot and
  the **exact** net offer match one ledger bid and one PPCM bidder; anything else is counted.
  **PPCM writes an e-auction's times as Yerevan wall clock in UTC** — 4 h ahead of
  eauction.armeps.am, while its ARMEPS times are true — and `ppcm/observation.js` moves them
  back, or 5% of e-auctions (announced after 20:00) fail rule 3's day comparison.
- **PPCM's missed-tender sweep finds what Tendra never had** (ticket 12, `ppcm.sweep`,
  `missed-ppcm` daily). It reads the organized-procedures report **by announcement day**, per
  competitive form, 90 days back, every day: every row of a procedure shares its announcement,
  so a day holds whole procedures, and each goes through the ask by code's own
  `recordProcedure`. Single source is not swept (never a miss). An unmatched procedure carries
  ticket 31's `was_public`: **a miss is `no_candidate` and `was_public` true**, and no operator
  alert reads it yet. A competitive one asks **bid-report** for its armeps.am `resourceId`
  (`ppcm.repair`, once per code a day) and queues `armeps.detail`; a page bid-report names, not
  `paperBased`, makes the procedure public whether or not gnumner listed it (`armepsPage`), and
  its stored answer is read back as that fact by every later sweep. bid-report answers **only
  the request its own page sends** — every filter field present and an `order` — and
  `{"status":500}` to anything less, which is all research.md ever sent it; refused, the
  procedure stays `no_candidate` and the sweep does not fail. A created ARMEPS or e-auction
  tender asks PPCM about its code again (`queuePpcmRetries`), so a repaired tender takes its
  result. PPCM lists paper procedures beside ARMEPS ones, so a non-auction row is
  `channelUnstated`: a code held only on paper or e-auction is `other_channel`, not a miss.
- **gnumner's e-auction listing is swept as a coverage check, never ingested** (ticket 34):
  one more slug on the shared chain, with its own `cron` (hourly, `sweep-gnumner-eauction`) and
  `priority`, its notices in `listing_notices` under ids of their own (`listing:eauction:eauction:{tmid}`: a
  row keeps the listing that wrote it first, and publicity reads by listing). `sources:verify` holds a
  notice by its title's code or, for a title naming none (~7 in 10), by an e-auction tender
  published in the same second, never more notices than that second's tenders. **Its rows are not a publicity fact**: `publicityFacts` reads
  only the listings it is given (required — an empty list would make `codeSeen` false, which
  creates tenders), so e-auctions' `was_public` stays null and a span is not made "unknown" by
  every code-less e-auction title.
- **Rule 3 refuses a single-source disagreement**: a result and a tender that both state a
  procedure type and disagree on whether it was single source are not one procedure, so a
  single-source price never lands on a competitive tender (and into competition figures), nor
  the reverse. PPCM names single source «Մեկ անձ» / «Հրատապ մեկ անձ»; its negotiated forms
  map to `single_source` too, as armeps.am's do.
- **Empty on purpose:** `contracts` (post-award, phase 6) and, for e-auctions, `cpv_code` /
  `cpv_codes` / `parties.tax_id` (all live only inside the invitation ZIP — see the document stage).
- **A new document set is an amendment** (ticket 18, `services/addendum.service.js`). An
  addendum moves no field the amendment hash reads, so the document stage compares the new
  set's file list with the previous one's (name, CRC, size from `tender_documents.manifest`,
  never the archive bytes) and, on any difference, raises `version` in the transaction that
  writes the new document row, turns `active` into `amended` while the tender is open (an
  alertable status, deadline ahead), and queues the
  ordinary amendment alert with `changedFields: []` and `documentChanges` — the alert names
  files, never a field. Past the deadline, closed, awarded or cancelled: version only, no alert. A
  tender's first set is not an addendum, and an unknown previous list raises nothing.
  `deriveStatus` keeps `amended` over a page that says "open". Both sources, one rule, but it
  only ever fires for ARMEPS: an e-auction invitation is written once and never re-issued
  (ticket 27). The previous set is read by tender, not by the archive's ref.
- **An e-auction amendment is a new tid that joins the old one's tender** (ticket 29, ADR
  0004). The page names its predecessors under «Աճուրդի սկզբնական հրավեր(ներ)»; the old page
  turns Փոփոխված and leaves the listing. **The pointer decides, never the code**: a same-code
  tender with no block is a re-announcement. The named runs become `superseded` links
  (`tender_sources.observed_status`, sticky, written with no request) — Փոփոխված is a link
  status, not a tender status, and is deliberately absent from `detail.parser.js#STATUS`. A
  superseded link is never refreshed, and a page or archive read through one writes only the
  link. **Readers that fetch by id follow the current link** (`tender.repo.js#currentLink`):
  the refresh, the document stage, `documents:backfill`; `tenders.source_id` stays the creating
  link and may be a dead run. The join's one alert waits for the replacement's archive (the
  document job carries `amendment`) so it can name moved fields and changed files together, and
  is raised without the files if the download never lands. Predecessors on two tenders: the
  replacement is created as a new run, the join is an `ambiguous` unmatched result naming
  both, and nothing is merged.
- **An amendment reaches trackers too** (ticket 28): the matcher's recipients for an amendment
  are the matched organizations ∪ those tracking the tender at `considering`, `preparing` or
  `submitted` (`AMENDMENT_PURSUITS`) — `submitted` because a sealed ARMEPS or paper bid can be
  withdrawn before the deadline. One job, one producer, one `(amendment, v{version})` dedupe
  key, so matching and tracking is one alert. Ingest alerts stay saved-search only. The matcher
  applies the open rule (deadline ahead) to every amendment, the normalizer's included.
- **A tender keeps every CPV code its source states** (ticket 17): `tenders.cpv_codes`, a sorted
  `text[]` beside `cpv_code`, which stays the primary one. armeps.am lists a tender's codes without
  saying which lot is which, so a code can be on the tender and on no lot — and it is still a fact
  about the tender. The matcher, the discovery CPV and field filters and relevance all read
  primary ∪ `cpv_codes` ∪ lot codes: `libs/cpv.js#tenderCodes` in JS, its SQL twin
  `tender.repo.js#tenderCodesSql`, which must move together. A page-stated list (armeps.am) that
  moves is an amendment; a **blank** stored list filled by a re-read is not, or the first refresh
  after the deploy would re-notify every old tender. An e-auction's list is replaced by its
  invitation archive and raises no event, like its lots. Its ingest match runs before the archive
  arrives, so every document set stored for an **open** tender re-runs it — `TenderIngested`, one
  `match-{id}-docs-…` job per stored archive, any priority — and dedupe silences what it already
  said (ticket 25). Open is the whole guard: backfills store closed tenders.
  `npm run cpv:backfill` fills old rows from storage, writes the column only and raises no alert
  (dry run by default; it reports the alerts the codes would have raised).
- **Still no writer:** `contracts`, `invoices`, `audit_logs` — phase 5/6, and `invoices` perhaps
  never (ADR 0005). `subscriptions` is read by `planFor`; the trial and promo redemption (F-02) write
  it.
- **Telegram and email are the two live delivery channels**, driven by one policy engine.
  `services/notifier.service.js` owns recipient resolution, outcome mapping and delivery
  recording for both; `TRANSPORTS` in that file holds the only per-channel differences, and it
  refuses to load if its keys disagree with `DELIVERABLE_CHANNELS`. Copying the engine per channel
  would have produced two subtly different answers to "is this deferred or failed", which is the
  question every log line and metric is built on.
- **Only a private Telegram chat can be linked.** `handleStart` refuses a group or supergroup, so
  every row is one person's DM by construction — there is no shared room, and therefore no way for
  one member's action to silence a channel their colleagues rely on. The check **fails closed**:
  anything not explicitly `private` is refused, and `chat.type` is declared in
  `telegramUpdateSchema` for that reason — the polling worker passes the raw update but the webhook
  passes a `stripUnknown` copy, so an undeclared field would reject every link in production while
  working perfectly in development. The token is **not** consumed on refusal: opening the connect
  link in a group is an ordinary mistake, and burning the token would make the fix fail too.
  This is also why `channel_subscriptions.user_id` is `ON DELETE CASCADE` and not `SET NULL` — the
  SET NULL existed so an org kept a shared room when its creator left, and with no shared rooms it
  would only leave an orphan chat receiving alerts that nobody can revoke.
- **A Telegram chat is linked; an email address is not.** A bot cannot open a conversation, so a
  chat arrives through a `t.me/<bot>?start=<token>` deep link with a single-use, short-lived token.
  Email needs no such dance for a member's **own** address: `users.email_verified_at` was set
  before they could log in, so a second confirmation mail is theatre — and theatre that fails
  silently when it lands in a spam folder. A *shared* address (`alerts@company.am`) has no verified
  owner and would still need the token flow.
- **Alert mail goes through the same port as auth mail** (`libs/adapters/email/`), so there is no
  second SMTP client to get STARTTLS wrong. There is deliberately no `channel/email.js` beside
  `channel/telegram.js`: the email channel is a formatter plus a policy, and the transport is
  borrowed.
- **Delivery has four outcomes, not three: `sent`, `deferred`, `skipped`, `failed` — and a fifth
  state, `held`, that is not an outcome yet.** A throttled
  provider (429) defers an alert to a `deferred` row that `notify.deferred` sweeps — never drop it,
  and never burn an attempt on being rate-limited — and the sweep walks every deliverable channel
  rather than the hardcoded `'telegram'` it once named twice. `skipped` means the org has not
  switched that channel on. `held` is a `tender-match` waiting for a daily destination's 08:00
  digest (daily-digest ticket 02): the destination's held rows ARE its next digest, no timestamp
  beside them, and `digest.send` turns them `sent` or `failed` through the same `applyOutcome` as an
  alert (a throttled digest leaves them held and delays the job). Folding any of these into `failed` makes a working configuration look like a
  broken channel in every metric, which is how a real outage stops being visible. **A channel records its own `alert_deliveries` rows and callers must not** —
  one alert fans out to every linked destination, so one row per destination is the honest record.
- **A live `channel_subscriptions` row IS the switch, and it is the only one.** Decided
  2026-09-10: there is no per-user preference layer and no quiet window. A channel delivers for an
  organization exactly when that organization has a verified, unrevoked row for it; turning a
  channel off is revoking its rows, turning it on is linking again. **Cadence** (`instant` |
  `daily`, 2026-11-07) is a property of that same row — the destination — and not a preference
  store: it says only *when* a live destination hears about a new match, never *whether*. There is
  still one row and one switch. Only `tender-match` is held for a daily destination; every other
  type reaches every live destination at once. New Telegram chats start `instant`, new email
  destinations `daily`, set by the repository (the column has no default). `notification_preferences`,
  `muted_types`, `TRANSPORTS[].personal` and the `quiet_hours_*` / `timezone` columns were built
  and then **removed** — do not rebuild them from this file's history or from the reference spec's
  BR-10 without asking. The reason is that a second store of "should this be delivered" is a second
  answer that can disagree with the first, and the subscription row already answers it.
- **Switching a channel on and off lives under `/integrations`, for both channels.**
  `GET/POST /integrations/email` and `DELETE /integrations/email/:id` mirror the Telegram routes;
  this is where `PATCH /notifications/preferences` went. `POST /integrations/email` takes **no
  body** — the address is always the authenticated user's own verified account address, which is
  what stops the endpoint from aiming an org's alerts at a mailbox nobody consented to. A shared
  `alerts@company.am` has no verified owner and would still need the Telegram-style token flow.
- **Switching a channel off never deletes anything, and switching it back on never re-links.**
  `revoke` sets `revoked_at` and erases nothing — the address and the `verified_at` that proves
  someone owns it both survive, which is precisely what makes
  `POST /integrations/{telegram,email}/:id/enable` able to clear that timestamp instead of running
  the deep-link dance again. For Telegram that is the point: the chat id exists only because the
  user messaged the bot once, and charging them a second `/start` to undo their own click is a tax
  on changing their mind. The only rows ever deleted are pending links nobody redeemed
  (`purgeExpiredTokens`), which have no address and were never a destination.
- **`listForOrg` includes revoked rows, and that is load-bearing.** It used to filter them out,
  which made switching a channel off *look* like deletion: the row survived but the API stopped
  mentioning it, so a client had no off state to render and no id to switch back on. The listing
  reports `linked`/`active`, `pending` and `off`, active first.
- **Turning a channel ON is scoped to the caller; turning it OFF is scoped to the organization.**
  The asymmetry is deliberate, and it is the same rule the unsubscribe token follows. Switching a
  colleague's alerts off is configuration; switching them on starts sending messages to their
  private chat or personal inbox, and whoever turned it off may have been the recipient saying stop
  — through `/stop`, or the link in a message. `savedsearch:write` must not overrule that. Every
  row is one person's own destination now that only private chats can be linked, so "your own" is
  well defined. Enabling also resets `failure_count` and `last_error`: a destination auto-revoked
  after repeated failures is getting a real second chance, and an inherited count would revoke it
  again on the first hiccup.
- **Alert mail carries an unsubscribe link, and it is the only unauthenticated write path besides
  the Telegram webhook.** `GET /api/v1/unsubscribe` previews, `POST` acts — and that split is not
  REST pedantry: corporate mail security scanners open every URL in every message before the
  recipient sees it, so a GET that unsubscribed on sight would silently switch alerts off for the
  customers whose employers scan hardest. RFC 8058 one-click wants the POST anyway, so the safe
  design and the standard one coincide. The token is an **HMAC over the subscription id**, domain-
  separated with an `unsubscribe:` prefix because the same secret signs access tokens and
  reset-code digests — there is no column to migrate or leak. It switches a channel **off only**:
  the link travels through relays, archives and forwarded threads, so the worst a finder can do
  must be the effect the link is for. Turning a channel back on means signing in to
  `/integrations`. Revoking is idempotent — a mail client may retry one-click and an archived
  message works forever, so a second click must not report failure at the moment it already
  worked. Both `List-Unsubscribe` headers are emitted together or not at all, and not at all when
  `APP.API_BASE_URL` is unset: a dead unsubscribe button earns a spam report, which is the thing
  the link exists to prevent. The reason to care is self-interested — providers score a sending
  domain on spam complaints, and enough of them put password-reset mail in junk too.
  Telegram alerts carry no such link because `/stop` already does it in the chat the person is
  already reading.
- **`APP.API_BASE_URL` is where this API answers publicly; `APP.BASE_URL` is where the product
  lives.** Two settings because they are two machines and, today, two states of existence — there
  is no frontend, but the API is deployed. An unsubscribe link has to survive that gap, so it
  points at the API.
- **No subscription is `skipped`, never `failed`.** An org that deliberately uses one channel must
  not look like a broken installation of the other in every metric built on `alert_deliveries`.
  The row is still written, with its reason — "alerts do not work" is a support question and that
  row is the honest answer.
- **`saved_searches.channels` defaults to `[]`, not `['email']`.** The old default named a channel
  that was a not-implemented stub, so every saved search created through the API recorded a failed
  delivery per match and reached nobody — the org's linked chat was never consulted, because the
  `channelsForOrg` fallback only fires when the array is empty. The valid set is now
  `DELIVERABLE_CHANNELS`, so a channel with no transport cannot be selected at all.
- **API:** `/api/v1` serves auth, tenders, saved searches, notifications, intelligence and
  integrations behind the four authorization gates. `middlewares/{auth,authorize,rateLimit,validate,error}.js` are all
  implemented.
- **Email verification is mandatory, and the gate lives in `sessionFor`** — not in `login`. Login is
  not the only thing that will ever mint a session: `switch-org` is designed to, and one choke point
  is the only way a path added later cannot forget the check. `POST /auth/register` returns
  **201 with no tokens**; handing back a session there would mint credentials the very next request
  rejects. `users.email_verified_at` is the durable fact and only the one-time token lives in Redis.
- **Multi-user organizations (F-05) are built** as *Account and organization model* describes:
  registration creates only the user; `POST /organizations`, `POST /auth/switch-org`, the roster,
  invitations (send/list/cancel, and the invitee's list/accept/decline), role change, removal,
  leaving, transfer and deletion all run. `docs/API_REFERENCE.md` documents every endpoint. Things
  decided while building that the model above does not say:
  - **The rank rule also covers the role being granted.** An admin may not promote anyone to
    `admin` or invite at `admin`; only the owner may. Otherwise the rule that stops a compromised
    admin removing administrators would not stop it minting them.
  - **Rank decisions re-read the actor's role from `memberships`**, never the token, and repeat the
    rank and owner-seat conditions in the UPDATE/DELETE `WHERE`, so a race is a no-op rather than a
    decision against a stale read.
  - **Ending a membership deletes the member's `accepted` invitation.** A re-invite leaves accepted
    rows untouched (that person has joined), so without it a removed member could never be invited
    back.
  - **Team announcements go through `services/announcement.service.js`**: the request records the
    notification and queues `notify.deliver` on ALERTS, so no HTTP response waits on Telegram or SMTP.
    A notification recorded but never delivered is re-queued on the next raise. `user_id` is the
    actor. BullMQ refuses a custom job id containing `:` unless it splits into exactly three parts —
    use hyphens. A finished job keeps its id, so re-queueing under a fixed id removes a
    completed or failed one first (`checklist.service.js#generate`).
  - **Deleting an organization** refuses while a pending vault upload is younger than the upload-URL
    TTL, and locks the organization row `FOR UPDATE` before re-checking vault keys and membership, so
    nothing registered concurrently is cascaded away with its object left in the bucket.
  - **Plan gating on invitations** uses `authorize('user:manage', { planGate: 'invitations' })`; every
    other `user:manage` action stays role-gated. A trial or promo organization can therefore
    invite; a lapsed one keeps its members but cannot invite more — growth-gated, shrink-free.
- **Reset codes have an attempt ceiling, and that is the actual lock.** Six digits is a million
  possibilities — roughly a minute of scripted guessing — so a code that merely waits out its TTL
  under unlimited tries is a delay, not a factor. `authStore.js` burns the code on the fifth failure;
  the route's rate limit is the outer wall. `verify-reset-code` deliberately does **not** spend the
  code (`reset-password` re-checks it), or a user who pauses over their new password would find it
  dead — but a wrong guess still costs an attempt, or the check-only endpoint becomes the unlimited
  oracle the ceiling exists to prevent.
- **A password reset revokes every session** — `refresh:user:<id>` indexes a user's token families
  precisely so it can. A reset that leaves old refresh tokens alive does not lock out whoever
  prompted it. It also marks the address verified: reading a code out of that inbox is stronger proof
  than the confirmation link would have been.
- **Redis never holds a usable auth secret.** The verification token is stored under a
  SHA-256 of itself; the reset code under an HMAC keyed on the app secret and bound to the
  address. A dump of that database yields nothing presentable back to the API.
- **Email verification is read → write → delete, in that order.** A `GETDEL` would hand back the only
  copy of the token and lose it if the database write then failed, stranding a user whose link now
  works for nobody. A credential that must be spent exactly once is the opposite case and wants
  `GETDEL`; this one must survive a failed write.
- **Mail goes through the email port**, `libs/adapters/email/`, which picks `smtp` or `log` from
  `EMAIL_DRIVER` the way the storage port picks its driver. `log` prints the message body — reset
  code and all — to the logger; that combination looks like working auth right up until a real user
  needs their password back. A send failure is logged, never thrown: the account is already
  committed, and a 500 would tell the user their registration failed when the address is now taken.
- **The `log` driver is refused in three places, and all three are needed.** `server.js` and
  `workers/index.js` both **refuse to boot production with it** — they are separate deployables and
  can be given separate environments, and the worker is the one that sends alert mail, so the API's
  check was never cover for it. Then `applyOutcome` refuses to record a `logged` result as `sent`
  outside development at all: an alert marked delivered in `alert_deliveries` when nothing left the
  building is precisely the silent failure that table exists to prevent. That third check is
  deliberately stricter than the boot checks — it trusts no NODE_ENV but the one where printing to a
  log is the intent — and it returns before the failure counter, because a misconfiguration must not
  revoke subscriptions whose addresses are fine.
- **`/auth/forgot-password` and `/auth/verify-email/resend` answer identically for every input.** Both
  take a bare address and send mail, so any difference in wording, status or shape makes them an
  account-existence oracle needing no credentials. The response objects are module constants for
  exactly that reason — two branches cannot drift apart if there is only one object.
- **Intelligence (phase 3) is built:** price benchmarks (tiered, materialised, including
  buyer-specific pairs), `competitor-prices` per tender, expected competition, buyer and supplier
  profiles, and an AI price recommendation. Competitor prices and win rates are the features that
  need **no CPV**, which is why they work across the whole corpus.
- **Bid pipeline (phase 4a/4b) is built:** `tracked_tenders` and `bids` have writers.
  `/tracked-tenders` serves the board, the pursuit state machine, the draft bid and the
  submit lock; `/organization/supplier-identity` claims the parties this org bids AS.
  `bids.reconcile` (half-hourly, on the ALERTS queue) resolves submitted bids against the
  public ledger into `won` / `lost` / `not_found`, storing `winning_price` at resolution time.
  Deadline reminders now run **two** sweeps: the matched safety net plus a tighter
  pipeline countdown on `considering`/`preparing` pursuits only.
- **`supplier_identities` is the join that makes win/loss possible.** Awards and the public
  bid ledger identify a bidder by `parties.id`; without a claim there is no way to ask "did we
  win". Each party is claimed explicitly by a human from a search — **never auto-matched on
  name**. Party names are scraped Armenian legal names with inconsistent quoting, and a fuzzy
  link would attach one company's win record to another account invisibly. **A set** (ticket
  32, replacing `organizations.supplier_party_id`): one company is several parties until a
  ՀՎՀՀ joins them, so reconciliation, the win rate and relevance read every claim, and a lot is
  won when ANY claimed party holds its award (`publicBid.repo.js#supplierEntriesForTender`).
  A party is claimed by one organization at most (`supplier_identities_party_uq`), and an
  organization claims at most 10: a claim is exclusive, so uncapped it locks other companies
  out of their own win records.
- **`not_found` is a real bid outcome, not an error.** The org says they bid, the ledger does
  not list them: either it was never submitted, or the ledger is not published yet. Recording
  `lost` there would fabricate a defeat. It stays unresolved on a non-cancelled tender so the
  next sweep retries.
- **A bid is decided per lot, by the lot's award** (decided 2026-10-27, every source):
  `won` only if the org's party holds the lot's award, `lost` only if another party does — or
  the lot's failure is on record (`publicBid.repo.js#supplierEntriesForTender` `lot_failed`: the
  tender cancelled, a failure notice naming the lot in `tender_sources.failed_lots`, or the
  source rejecting every bid on it), which keeps the old handling, `lost` with no winning price.
  A lot with bids and neither is a result still to come — PPCM publishes an ARMEPS lot's bids
  before its contract, and they are stored as soon as published — so `decide` returns no outcome
  and the sweep retries, like `not_found`; `resolveOne` (on submit) writes nothing then either.
  A bid naming no lot is `won` if any of its lots is won, otherwise undecided while any is open.
  The rejected-every-bid reading of "failed" is what keeps e-auction as it was: all 751 of its
  lots without an award on a live tender are exactly that, and would otherwise never resolve.
- **A win comes from `awards`, never from `rank = 1`** — the same rule the ingestion layer
  learned the hard way. The source ranks rejected submissions too.
- **Every offer has two prices, and each question uses one.** The ledger publishes the value
  without VAT (`*_net`, `awards.net_amount`) and the price with it (`*_price`, `awards.amount`).
  The auction ranks on net — 0 rank inversions across the corpus on net, 590 on gross — so
  anything comparing bidders, or telling a supplier what to bid, uses net: the gap from the
  winner, price ranges, benchmark prices, the recommendation, `bids.price`/`winning_price`. The
  budget is gross and the source rejects an offer whose *gross* exceeds it, so anything
  compared with the budget uses gross: discount %, the opening-offer check, buyer spend. Only
  the gross figure was stored until 2026-10-17, which put a VAT-paying winner up to 20% above
  rivals it beat; found by cross-checking HayTender, which shows net.
- **`sample_size` is not sample independence.** Awards are per lot, so one multi-lot procurement
  can clear `MIN_COMPARABLES` alone, and most categories that pass draw from only a handful of
  distinct tenders. `price_benchmarks.distinct_tenders` carries the real figure; anything that
  states a confidence must read it, not `sample_size`.
- **AI bid checklist (phase 4c) is built** — `aiExtractor.js` was the last empty file and no
  longer is. `checklist.extract` reads the stored invitation text into `checklist_items` with a
  category, a confidence and a **verbatim evidence span**; `/tracked-tenders/:id/checklist`
  serves it and `POST .../generate` enqueues (202, polled — a model call over a full invitation
  is far past an HTTP budget).
- **Every extracted item must quote the document, and the quote is verified in code.** An item
  whose `evidence` is not actually present in the source text is dropped by
  `ChecklistExtractionService.verifyEvidence`, not merely discouraged in the prompt. This is the
  checklist's equivalent of `insufficient_data`: a plausible invented requirement is the worst
  thing the feature could ship, and a prompt rule is guidance while a containment check is an
  invariant. Comparison is whitespace-normalised, because run-together spacing is a .docx
  extraction artifact rather than a property of the document.
- **Below `AI.CHECKLIST_MIN_CONFIDENCE` an item is flagged for human review**, and the
  flag is **stored, not recomputed on read** — otherwise raising the threshold would silently
  re-open items a human had already cleared.
- **No invitation document means `status: 'unavailable'` with a reason, never an empty
  checklist.** An empty list reads as "nothing is required for this tender", which is the most
  dangerous thing this feature could say. Most tenders have no stored archive,
  so this is the common path, not the edge case.
- **An oversized document is refused, never truncated.** Requirements cluster at the END of an
  invitation (annexes, submission instructions), so truncation would drop exactly what the
  feature exists to find while still looking complete.
- **Manual items survive a regenerate.** `replaceItems` deletes only `source = 'ai'` rows. A
  human who adds a requirement the model missed must not lose it, or they stop correcting it —
  and a manual item carries `confidence: null` / `evidence: null` rather than a fabricated 1.0,
  so a person's assertion stays distinguishable from an extraction.
- **A tender's invitation files are listed and downloadable one by one**, always from our
  stored ZIP — never fetched from the source on a click. The list is taken once at ingest into
  `tender_documents.manifest` (`npm run documents:manifests` fills old rows from storage); a
  download streams one entry out of the stored ZIP with ranged reads
  (`libs/adapters/archive/zip.js`), so memory stays flat and nothing is extracted to its own
  object. `files: null` with `availability` `unlisted`/`not_stored` is how the API says "we
  don't know", never `[]`. `language` comes from the filename only — `null` rather than a guess.
- **The document vault (phase 4d) is built.** `/vault-documents` serves the certificate
  library; `vault.expiry` sweeps daily for lapsing documents, lapsed ones and
  abandoned uploads.
- **Uploads never pass through the API.** `POST /vault-documents` registers what the client is
  about to send and returns a presigned PUT; the client uploads straight to object storage;
  `POST /:id/confirm` asks storage whether the object arrived. A 20 MB scan streamed through an
  express handler is memory pressure on the process serving every other request, which is why
  `express.json` stays at 1 MB. **The key is minted server-side** from the organisation id and
  the content hash — a presigned PUT is a write capability, so a client-supplied key would let
  one tenant write into another's prefix. The content type, content length and SSE header are
  named in `signableHeaders` so they are actually binding; by default the presigner signs only
  `host`, and an "enforced" content type that is merely advisory lets an executable be stored
  under a key the vault reports as a PDF.
- **A row without `status: 'ready'` has no file behind it.** The three-step handshake means a
  row exists before its bytes do, so `pending` is what separates a real document from an
  abandoned upload; listings hide it, download and attach refuse it, and the daily sweep prunes
  it — a stale pending row holds the `(organization_id, hash)` slot and would block a later
  genuine upload of the same file.
- **Expiry is derived, never stored** — the exact opposite call from `checklist_items.needs_review`,
  and for the reason that decides it: a review flag is cleared by a human, so recomputing it
  would re-open cleared items, while expiry is a pure function of `valid_until` and the clock,
  so a stored copy could only go stale. `valid_until` NULL means "does not expire" and never alerts.
- **Deleting a vault document deletes the file**, object first and row second — the ordering
  that leaves a failed erasure retryable rather than reporting success while the certificate
  survives in the bucket. Checklist items pointing at it are detached, not deleted: the
  requirement still exists, it is simply unmet again.
- **A vault alert has no tender**, which broke BR-9 dedupe — `(org, type, tender_id)` collapses
  every expiring document in an org into one notification. `notifications.subject_id` is the
  dedupe key for non-tender alerts, and for an `amendment` it is `v{version}` (ticket 18):
  with it NULL, the first amendment of a tender was the only one any organization was ever
  told about. It stays NULL for everything else. BR-9 is now a
  constraint rather than a convention: `notifications_dedupe_uq` on `(organization_id, type,
  tender_id, subject_id)` **`NULLS NOT DISTINCT`** — almost every row has a NULL in that key by
  design, so under the default NULLS DISTINCT the index would accept every duplicate it
  exists to stop while looking correct in `\d notifications`. `createIfNew` reads first and
  inserts `ON CONFLICT DO NOTHING`, so the loser of a concurrent raise reads back the
  winner's row instead of throwing — a unique violation here is the constraint working, the
  same rule as on ingestion.
- **An ASCENDING cursor must truncate timestamps to milliseconds on both sides.** Postgres
  stores `timestamptz` to the microsecond; node-postgres hands JavaScript a `Date`, which holds
  milliseconds. A cursor built from a fetched row therefore encodes a value slightly EARLIER
  than the row it came from, so an ascending keyset returns that row again on the next page —
  observed on a real list, not theorised. Every cursor in the codebase today
  (`trackedTender.repo.js`, `vaultDocument.repo.js`) is DESCENDING, where the same truncation
  is harmless: it excludes the cursor row correctly and can only drop a row created inside the
  same millisecond. The next ascending one needs `date_trunc('milliseconds', …)` in the keyset
  AND the ORDER BY, which must agree.
- **Schema changes go straight into `create_table.js` and `drop_table.js` — no additive
  scripts** (decided 2026-11-01, overruling the earlier four-step add-script workflow). This is
  development: a database is rebuilt from `create_table.js` (`migrate:down` then `migrate:up`)
  rather than altered in place, so a one-shot `add_<thing>.js` is a second copy of the schema
  that can only drift from the first. Write the change in `create_table.js` — table, CHECKs and
  partial indexes in `indexes()` — and the matching drop in `drop_table.js`, in dependency order.
  To check it, build a scratch database from `create_table.js` and drop it with
  `drop_table.js`. Applying a change to an existing database without a rebuild is a hand-run
  `ALTER`, never a file in `migrations/`. `migrations/` holds only those two files; revisit this
  once a database holds data that a rebuild would lose.

## Docs

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | components, boundaries, layering, target folder tree, data model, queue topology, domain events |
| [docs/SCRAPER_WORKFLOW.md](docs/SCRAPER_WORKFLOW.md) | ingestion pipeline stage by stage, idempotency and failure model |
| [docs/AI_COST_MODEL.md](docs/AI_COST_MODEL.md) | what each AI feature costs, measured vs estimated, cost levers, quota design |
| [docs/COMPETITORS.md](docs/COMPETITORS.md) | field notes on itender.am — the closest real competitor, absent from the spec |

### Reference specification (outside this repo)

The full product and engineering spec lives at `../CRM/gov-tender-monitoring/docs` — one
self-contained document per topic, each following a Purpose · Overview · Detail · Diagrams · Examples
· Edge cases · Alternatives · Trade-offs · Risks template. Its `README.md` is the canonical fact
sheet. Consult it before designing anything new; it almost certainly already specifies the thing.

| Folder | Read it when |
|---|---|
| `backend/build-guide/` | Deciding what to build next — phases 0–6, ordered by dependency, one line per task |
| `backend/` | Writing a service, repository, middleware, worker, or error handler |
| `api/` | Adding an endpoint — endpoint catalog, REST standards, error codes, pagination, filtering |
| `database/` | Changing the schema — tables, relationships, indexes, constraints, migration strategy |
| `product/` | Checking a business rule, requirement, or acceptance criterion |
| `security/` | Auth flows, JWT strategy, role/permission matrix, encryption, audit logs |
| `ai/` | Building the AI extractor — prompts, model routing, safety, evaluation, fallbacks |
| `architecture/`, `technical/` | Queue topology, caching, storage, jobs, data/event flow |
| `testing/`, `deployment/`, `operations/` | Test strategy, CI/CD, Docker, runbooks, incident response |
| `frontend/`, `ux/` | The planned Next.js client — not started |
| `business/`, `research/` | Why a decision was made; market and pricing context |

Three caveats when reading it: it assumes Prisma/Zod/feature-folders (see *Deliberate deviations*),
its AI model IDs predate the current Claude generation (see *AI layer*), and its payments
architecture rests on bank transfer and VAT invoices, which are ruled out (ADR 0005 — card through a
bank vPOS). Everything else transfers.

## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/<feature-slug>/` in this repo — there is no
`gh`/`glab` workflow, and the GitHub and GitLab remotes are push targets, not boards. See
[docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

### Triage labels

The five canonical triage roles under their own names, carried as a `Status:` line in the issue file
rather than a tracker label. See [docs/agents/triage-labels.md](docs/agents/triage-labels.md).

### Domain docs

Single-context: one [CONTEXT.md](CONTEXT.md) glossary and one `docs/adr/`, both at the repo root.
See [docs/agents/domain.md](docs/agents/domain.md).
