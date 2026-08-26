# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

TenderIQ is supplier-side bid-intelligence SaaS over Armenian public procurement data. It scrapes
public tender notices, normalizes them into an OCDS-aligned model, and (eventually) turns that into
discovery, alerts, price benchmarks, and bid workflow. It is not a procurement platform and does not
replace ARMEPS. Users are **suppliers only** — the companies that bid.

Node.js ESM (`"type": "module"`), no build step, no TypeScript, no transpiler — files run as written.

**Strategic clock:** Armenia's OCDS-based procurement platform launches **2027-01-01**. The
OCDS-aligned data model exists so that migration is a source-adapter swap, not a rewrite. Scraping is
the pre-2027 bridge, and it is the system's primary architectural risk.

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
docker compose --profile local-db up -d    # ...plus local Postgres (.env points at Neon by default)
```

**There is no test runner.** `tests/` is empty and `devDependencies` has only nodemon. If a task
needs tests, the runner has to be chosen and added first — don't assume `npm test` exists. When tests
do arrive, the reference spec puts the coverage where the risk is: **cross-tenant denial**,
**intelligence correctness (`insufficient_data`)**, and a **listing-parser fixture test** — the one
that would catch a gnumner redesign before customers do.

**There is no linter or formatter configured.** Match surrounding style; the codebase is
2-space, single-quote, semicolon.

Migrations are hand-run scripts, not the Knex CLI. `migrate:up` runs `up()` over the whole schema in
one transaction and is not idempotent; `migrate:down` drops all 30 tables. A schema change means
editing `db/migrations/create_table.js` *and* `drop_table.js`, or adding a new script.

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
  `organization_id` by the repository, not by the caller.
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
- **Pagination depth is the tid high-water mark, not `maxListingPages` and not a time window.** The
  board is a 9-year archive, not a live feed, and its listing table has **no publish-date column** —
  a time-based rule would compare against a field that does not exist (it did, silently, and made
  every sweep walk 40 pages). tids ascend with publication and the board is newest-first, so continue
  to page N+1 only while the page's lowest tid is still above `sweep:tid:{source}:{slug}`. The
  watermark advances only when a chain terminates, so a sweep that dies mid-chain re-walks the gap
  rather than skipping it. `maxListingPages` is the cold-start bound only. Loading history is a
  deliberate backfill with its own page range.
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
change → `db/migrations/`.

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
  `PLAN_UPGRADE_REQUIRED` (402) · `ROLE_FORBIDDEN` / `TENANT_FORBIDDEN` (403) · `NOT_FOUND` (404) ·
  `CONFLICT` (409) · `RATE_LIMITED` / `QUOTA_EXCEEDED` (429) · `INTERNAL_ERROR` (500, with
  `details.ref`) · `DEPENDENCY_UNAVAILABLE` (503). Keep them in one enum; a DB unique-violation on
  ingestion maps to 409 or idempotent-upsert, never a 500.
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

## Domain rules

Rules the code must enforce, independent of UI. The full list is in the reference spec's
`product/Business Rules.md`; these are the ones most likely to be violated by accident:

- **Dedupe by source ID.** A tender is uniquely identified by its ARMEPS tender ID. If a source ever
  reuses or rotates IDs, fall back to a composite key (buyer + subject + dates).
- **Amendments supersede but history is retained** — `version` + `is_latest`, readers filter on
  `is_latest`. Re-notification includes a change summary.
- **Never fabricate intelligence.** Below the comparables threshold, return `insufficient_data`.
  Benchmarks use only public award data and retain provenance.
- **Non-competitive / "wired-spec" flags are signals with evidence, never accusations.** This framing
  is mandatory — it is a legal and reputational constraint, not a wording preference.
- **No duplicate alert** for the same tender/event to the same user; respect channel preferences and
  quiet hours.
- **Expired certificates cannot be attached to a bid package**; a bid in `submitted` state is a
  read-only locked snapshot.
- **Publish only aggregated/anonymized statistics externally.** Private tenant data (bids, vault)
  never leaves its tenant.

Enum values are constrained at the DB level: `tender.procedure_type ∈ {open, quotation,
single_source, e_auction, restricted}`; `tender.status ∈ {planned, active, amended, closed, awarded,
cancelled}`; `tracked_tender.status ∈ {considering, preparing, submitted, won, lost, dropped}`.
Nullable on purpose: `tenders.deadline_at` (some notices lack it), `awards.supplier_id` (void or
undisclosed), `vault_documents.valid_until` (non-expiring docs) — features degrade rather than break.

## AI layer

The adapter and the first consumer exist: `src/libs/adapters/ai/anthropic.js` (the only file
that imports the SDK) and `services/priceRecommendation.service.js`. `aiExtractor.js` is still
empty. The rules below are enforced in that service and must hold for anything added:

- **Anthropic Claude API.** Use the current model IDs — `claude-opus-5`, `claude-sonnet-5`,
  `claude-haiku-4-5`. The reference spec's `ai/Model Selection.md` names an older generation; treat
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
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [PROJECT_STATUS.md](PROJECT_STATUS.md).
Where reference docs say "Prisma client", read "Knex instance"; where they say "Zod schema", read
"Joi schema".

## Current state

Ingestion, the HTTP API, discovery and the intelligence layer all run. **Bid workflow
(phase 4) onward does not.**

- **Working:** `source.sweep` (tid watermark) → `tender.detail` → `normalize.tender` writes
  `tenders`, `parties`, `awards`, `public_tender_bids`. `tender.refresh` re-checks settled tenders
  hourly. `backfill.js` seeds the historical archive on its own queue and process.
- **Single source:** `armeps` = eauction.armeps.am, reverse auctions only (`procedure_type` is
  always `e_auction`). Non-e-auction procedures are not covered; that would mean adding the gnumner
  notice board as a second source.
- **PPCM was removed**, not deferred. It is an AngularJS SPA rather than the CSV feed the reference
  spec assumes, and the eauction bid ledger already supplies the award data it existed for. `awards`
  and `public_tender_bids` have a `source` column so a second writer can be added safely later.
- **Empty on purpose:** `contracts` (post-award, phase 6) and `cpv_code` / `parties.tax_id` (both
  live only inside the invitation ZIP — see the document stage).
- **Telegram is the one live delivery channel.** A bot cannot open a conversation, so a chat is
  linked by the user opening a `t.me/<bot>?start=<token>` deep link; the token is single-use and
  short-lived, and the chat id lands in `channel_subscriptions`. Quiet hours defer an alert to a
  `deferred` row that `notify.deferred` sweeps, never drop it. **A channel records its own
  `alert_deliveries` rows and callers must not** — Telegram fans one alert out to every linked
  chat, so one row per destination is the honest record.
- **API:** `/api/v1` serves auth, tenders, saved searches, notifications, intelligence and
  integrations behind the four authorization gates. `middlewares/{auth,authorize,rateLimit,validate,error}.js` are all
  implemented.
- **Intelligence (phase 3) is built:** price benchmarks (tiered, materialised, including
  buyer-specific pairs), `competitor-prices` per tender, expected competition, buyer and supplier
  profiles, and an AI price recommendation. Competitor prices and win rates are the features that
  need **no CPV**, which is why they work across the whole corpus.
- **`sample_size` is not sample independence.** Awards are per lot, so one multi-lot procurement
  can clear `MIN_COMPARABLES` alone — 47 of the 55 categories that pass draw from fewer than five
  distinct tenders. `price_benchmarks.distinct_tenders` carries the real figure; anything that
  states a confidence must read it, not `sample_size`.
- `aiExtractor.js` is still an empty file, but the Anthropic adapter it needs now exists at
  `src/libs/adapters/ai/anthropic.js` — the only file permitted to import the SDK.
- **Schema changes against the live database go in an additive script**, not `create_table.js`:
  `npm run migrate:intelligence` is the pattern — `IF NOT EXISTS` throughout, safe to re-run,
  with the same change mirrored into `create_table.js` so a fresh database matches.

Read [PROJECT_STATUS.md](PROJECT_STATUS.md) for the file-by-file gap analysis in blocking
order before starting anything non-trivial; it is kept current and states the recommended next step.

## Docs

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | components, boundaries, layering, target folder tree, data model, queue topology, domain events |
| [PROJECT_STATUS.md](PROJECT_STATUS.md) | gap analysis against the reference spec, ordered by what blocks what |
| [docs/SCRAPER_WORKFLOW.md](docs/SCRAPER_WORKFLOW.md) | ingestion pipeline stage by stage, idempotency and failure model |

### Reference specification (outside this repo)

The full product and engineering spec lives at `../CRM/gov-tender-monitoring/docs` — ~169 files, one
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

Two caveats when reading it: it assumes Prisma/Zod/feature-folders (see *Deliberate deviations*), and
its AI model IDs predate the current Claude generation (see *AI layer*). Everything else transfers.
