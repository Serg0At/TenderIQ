# Project Status — Gap Analysis

> Where TenderIQ stands against the reference specification at
> `CRM/gov-tender-monitoring/docs`, in particular its
> [backend build guide](../CRM/gov-tender-monitoring/docs/backend/build-guide/README.md)
> phases 0–6.
>
> **Assessed:** 2026-08-17 · against the live codebase and the live Neon database.
>
> Companions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
> [docs/SCRAPER_WORKFLOW.md](docs/SCRAPER_WORKFLOW.md) ·
> [docs/PROSPECT_FEASIBILITY.md](docs/PROSPECT_FEASIBILITY.md)

---

## The headline

```
source_payloads = 1285    tenders = 104    parties = 281
awards = 721              public_tender_bids = 1886    tender_documents = 55
```

**The pipeline is closed end to end.** The previous assessment's single blocking item — an empty
`src/workers/normalizer.js` — is written, and raw payloads now become domain entities: tenders with
a real buyer, per-lot awards, and the full public bid ledger behind them.

What changed is not only that tenders exist. `public_tender_bids` is new, and it is the thing the
intelligence layer was missing: 1,886 rows of *who else bid and what they offered*, which no part of
the reference specification expected to be obtainable without the PPCM export. Phase 3 is now
blocked on code, not on data.

---

## Scorecard

| Phase | Reference scope | State |
|---|---|---|
| **0 — Foundation** | repo, config, entrypoints, middleware, auth, seed, health check | **~40%** |
| **1 — Ingestion** (moat feedstock) | scraper, normalizer, backfill, documents, freshness | **~85%** |
| **2 — Discovery** (the hook) | SavedSearch, tender API, matcher, notifier, reminders | **0%** |
| **3 — Intelligence** (the moat) | price benchmarks, buyer/supplier profiles | **0% code — data now present** |
| **4 — Bid workflow** (the glue) | pipeline, vault, AI checklist, tasks | **0%** |
| **5 — Accounts & billing** | plans, subscriptions, invoices, bank transfer | **0%** |
| **6 — Post-award & polish** | contracts, win/loss, exports, admin dashboard | **0%** |

Phases 2–6 have their **schema** and, for phase 3, their **feedstock**. They still have **zero
application code**.

---

## Done

### Phase 0 — Foundation (partial, unchanged)

| Item | State |
|---|---|
| Express + PostgreSQL + Redis + BullMQ stack | done |
| `variables.config.js` — env load + validate, refuses to boot on a missing key | done |
| `server.js` / `app.js` / `workers/index.js` entrypoints | done |
| Structured logging (winston, console + file transports) | done |
| Graceful worker shutdown (drains in-flight jobs on SIGTERM) | done |
| `docker-compose.yml` — redis + minio + bucket bootstrap, optional local postgres | done |

### Phase 1 — Ingestion

| Item | State |
|---|---|
| OCDS-aligned schema + `public_tender_bids` | done |
| Composite unique `(source, ref, hash)` on `source_payloads` | done |
| ARMEPS **listing** sweep — table parser, tid high-water pagination, rate-limit gate, TLS chain fix | done, verified live |
| ARMEPS **detail** parser — 10 lifecycle statuses, per-lot `Գնառաջարկներ` bid ledger | done, verified live |
| **Normalizer** — payload → `tenders` / `parties` / `awards` / `public_tender_bids` | **done** |
| Amendment versioning (`version`, `is_latest`) + `TenderIngested` / `TenderAmended` | done |
| `tender.refresh` — DB-driven hourly re-check of settled tenders | done |
| `tender.documents` — invitation archive → CPV code, buyer tax ID, per-lot items | done |
| Historical backfill worker (own queue, own process, resumable, low priority) | done, not yet run to completion |
| `reindexPayloads.js` — rebuild `source_payloads` from storage after a schema drop | done |
| `replayNormalizer.js` — re-normalize from retained payloads, no re-crawl | done |
| Raw payload retention, deterministic content-hash keys, `list()` on both storage drivers | done |
| Retry / backoff / DLQ policy | done |
| **Idempotency** | **proven**: a repeat sweep writes 0 rows and enqueues 0 jobs |
| Scheduler registration (`sweep-{source}`, `refresh-{source}`) | done |

### Outside the phase list

`prospects.repo.js` + `prospectScoring.service.js` + `exportProspects.js` turn the public bid ledger
into a ranked ICP prospect list for founder-led sales. Not a product feature and not on the phase
path — a research tool that exists because the data happened to be there. See
[docs/PROSPECT_FEASIBILITY.md](docs/PROSPECT_FEASIBILITY.md).

---

## Missing, in blocking order

### 1. Freshness and coverage monitoring

`sweep:ok:{source}` is written on every successful page and read by `lastSuccessfulSweep(source)` —
and **nothing calls it**. Missing tenders are the reference's #1 churn cause, so a silently broken
scraper is still the largest operational risk in the system. Needs a monitor job comparing against
`SCRAPER.FRESHNESS_SLA_MINUTES` (15), plus zero-block, DLQ-depth and skipped-row alerting.

This is small, and it protects everything already built.

### 2. Run the backfill to completion

The worker is written and idempotent but the archive is still ~97% unread: 104 tenders ingested
against roughly 29,000 on the board. The corpus size *is* the intelligence product — benchmarks
return `insufficient_data` until comparables exist. It is a multi-day run at the shared 20 req/min
budget, so it should be started early and left going.

### 3. Phase 0 gaps that block any API at all

| Gap | Detail |
|---|---|
| Middleware | `middlewares/{auth,authorize,rateLimit}.js` are **empty files**; `validate.js` and `error.js` do not exist |
| Routes | `app.js` mounts `/api/v1`, but `features/index.js` is an **empty Router** — no routes are registered |
| Auth flows | `features/auth/` exists as stubs: `auth.service.js` is empty, `auth.controller.js` has an empty `login()`, `auth.routes.js` registers nothing |
| Health check | not created |
| Seed | no roles or plans seeded; `users`, `organizations`, `roles`, `plans` all empty |

### 4. Rest of ingestion

| Gap | Why it matters |
|---|---|
| AI extraction (`workers/aiExtractor.js`) | **empty file**. The invitation archive's text is extracted and stored, so the input is ready; the phase-4 checklist reads it |
| PPCM importer | **Parked, not blocking.** An AngularJS SPA at armeps.am/ppcm, not the CSV/Excel export the reference assumed. Its only unique contribution is signed contract values (phase 6) — `importer.js` was deleted rather than left as a misleading stub |
| Per-lot technical specs | Retained in the archive but unparsed (.xls / .rar / .xlsx). Feeds phase 4, needs no re-download |
| Second source | ARMEPS e-auction is the only configured board. Non-e-auction procedures are not covered |

### 5. Phases 2–6

No code. In dependency order: matcher + notifier (needs `tenders` + `saved_searches`) → benchmarks
(needs `awards` + `public_tender_bids`, **both now populated**) → workflow → billing.

---

## Open defects

Found in review, not yet fixed. Listed so they are not rediscovered later.

| Severity | Where | Issue |
|---|---|---|
| **critical** | `utils/http.js` | The axios instance sets no `maxContentLength` / `maxBodyLength` (axios defaults to unlimited), so `MAX_DOCUMENT_BYTES` is only checked after the whole body is buffered. An oversized archive OOMs the worker process before the guard runs |
| warning | `invitation.parser.js` | Two nested ZIP decompressions with no size cap — the byte limit buys nothing past the wire |
| warning | `workers/normalizer.js` | The `tender.documents` job id is keyed on the detail-page hash, so each amendment re-downloads the same unchanged archive (~5× per tender lifecycle) |
| warning | `invitation.parser.js` | The buyer's tax ID is the first `ՀՎՀՀ` match anywhere in the document; any other party's number appearing earlier is attributed to the buyer |
| warning | `workers/documents.js` | `invitationUrl` comes from scraped HTML and is fetched with no origin check |

---

## Assumed by the reference, absent here

| Area | State |
|---|---|
| **Tests** | **none** — `tests/` exists but is empty; no runner in `devDependencies`. The listing- and detail-parser fixture tests are the ones that would catch an ARMEPS redesign before customers do |
| **API layer** | none — reference `/api` specifies endpoints, pagination, filtering, sorting, versioning, rate limits, webhooks, error codes |
| **Frontend** | none — reference specifies a Next.js + Tailwind client |
| **CI/CD** | none — no `.github/`, no `Dockerfile`, despite `/deployment` covering both |
| **Dead code** | `src/queues/worker.js` still exports the placeholder `ingestionQueue` that `app.js` imports; superseded by `src/queues/index.js`. It also reads `connectionOptions.host` off a default import that has no such property, so it silently connects to localhost |

---

## Deliberate deviations from the reference

Not omissions — decisions, recorded so they are not mistaken for gaps.

| Reference says | TenderIQ does | Why |
|---|---|---|
| Prisma | **Knex** + hand-written migrations | Explicit SQL, no hidden queries; repositories are the only DB layer |
| Zod validation | **Joi** | Already a dependency |
| Feature-first folders + `container.js` | Layer-first (`utils/`, `repositories/`, `services/`, `workers/`, `libs/adapters/`) | Fewer moving parts at this size; the seams that matter (storage port, source adapters, repositories) are intact |
| PPCM as the award-data source | ARMEPS e-auction bid ledger | Finer-grained (per lot, every bidder, not just the winner) and needs no SPA reverse-engineering |

---

## Recommended next step

**Start the backfill, then build Phase 0 auth and the tender API while it runs.**

The backfill is the long pole — days of wall-clock time at the politeness budget, and every
intelligence feature is a function of how much of the archive it has read. It needs no supervision
once started, so it should not be serialised behind anything.

That leaves the freshness monitor (small, protects what exists) and Phase 0 middleware + auth as the
work to do in parallel. Discovery is the first thing a customer can see, and it cannot be built
until a request can be authenticated and scoped to a tenant.
