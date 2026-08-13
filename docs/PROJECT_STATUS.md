# Project Status — Gap Analysis

> Where TenderIQ stands against the reference specification at
> `CRM/gov-tender-monitoring/docs`, in particular its
> [backend build guide](../../CRM/gov-tender-monitoring/docs/backend/build-guide/README.md)
> phases 0–6.
>
> **Assessed:** 2026-08-03 · against the live codebase and the live Neon database.
>
> Companions: [ARCHITECTURE.md](ARCHITECTURE.md) · [SCRAPER_WORKFLOW.md](SCRAPER_WORKFLOW.md) ·
> [SCRAPER_BUILD_GUIDE.md](SCRAPER_BUILD_GUIDE.md)

---

## The headline

```
source_payloads = 135        tenders = 0        parties = 0        awards = 0
```

Raw data is flowing in and is provably deduped, but **nothing has become a domain entity yet**.
Every feature in phases 2–6 reads from `tenders`, so the product currently has no readable
inventory. One missing file — the normalizer — accounts for that.

---

## Scorecard

| Phase | Reference scope | State |
|---|---|---|
| **0 — Foundation** | repo, config, entrypoints, middleware, auth, seed, health check | **~40%** |
| **1 — Ingestion** (moat feedstock) | scraper, importer, normalizer, backfill, freshness | **~45%** |
| **2 — Discovery** (the hook) | SavedSearch, tender API, matcher, notifier, reminders | **0%** |
| **3 — Intelligence** (the moat) | price benchmarks, buyer/supplier profiles | **0%** |
| **4 — Bid workflow** (the glue) | pipeline, vault, AI checklist, tasks | **0%** |
| **5 — Accounts & billing** | plans, subscriptions, invoices, bank transfer | **0%** |
| **6 — Post-award & polish** | contracts, win/loss, exports, admin dashboard | **0%** |

All 26 tables from `db/migrations/create_table.js` exist in the database, so phases 2–6 have
their **schema**. They have **zero application code**. Schema is not progress — it is a
promise.

---

## Done

### Phase 0 — Foundation (partial)

| Item | State |
|---|---|
| Express + PostgreSQL + Redis + BullMQ stack | done |
| `variables.config.js` — env load + validate, refuses to boot on a missing key | done |
| `server.js` / `app.js` / `workers/index.js` entrypoints | done |
| Structured logging (winston, console + file transports) | done |
| Graceful worker shutdown (drains in-flight jobs on SIGTERM) | done |

### Phase 1 — Ingestion (partial)

| Item | State |
|---|---|
| OCDS-aligned schema (`tenders`, `parties`, `awards`, `contracts`, `tender_documents`, `source_payloads`) | done |
| Composite unique `(source, ref, hash)` on `source_payloads` | done |
| `utils/{logger,hash,http,rateLimiter}.js` | done, verified live |
| ARMEPS listing scraper: rate-limit gate, TLS chain fix, charset decode, chained pagination, lookback-bounded early stop | done, verified live |
| Raw payload retention in object storage (MinIO), deterministic content-hash keys | done |
| Retry / backoff / DLQ policy | done — observed recovering from Neon connection timeouts |
| **Idempotency** | **proven**: cold start ingested 116 notices over 14 pages; a repeat sweep fetched 1 page, wrote 0 rows, enqueued 0 jobs |
| Sweep-health signal (`sweep:ok:{source}` in Redis) | written, not yet read by anything |

---

## Missing, in blocking order

### 1. The normalizer — the one that matters

`src/workers/normalizer.js` is an empty file. Until it maps raw payloads → `tenders` /
`parties`, there are 135 stored HTML snapshots and zero tenders.

It also owns:

- **Amendment versioning** — flipping `is_latest`, incrementing `version`.
- **Emitting `TenderIngested` / `TenderAmended`** — the events every downstream consumer
  subscribes to.

This single file blocks the entire product. It is the highest-leverage work in the repo.

### 2. Phase 0 gaps that block any API at all

| Gap | Detail |
|---|---|
| Middleware | `middlewares/auth/{auth,authorize,rateLimit}.js` are **empty files**; `validate.js` and `error.js` do not exist |
| Routes | `app.js` line 18 has `_initializeApi()` commented out — **no routes are mounted** |
| Auth flows | register / login / refresh (rotation + reuse detection) / logout — none exist |
| Composition root | `container.js` — not created |
| Health check | not created |
| Seed | no roles or plans seeded; `users`, `organizations`, `roles`, `plans` all empty |

### 3. Freshness monitoring

The signal exists but **nothing reads it**. Per the reference, missing tenders are the #1
churn cause — today a silently broken scraper would go unnoticed. Needs: a monitor job
comparing `lastSuccessfulSweep(source)` against `SCRAPER.FRESHNESS_SLA_MINUTES` (15), plus
zero-block and DLQ-depth alerting.

### 4. Rest of ingestion

| Gap | Why it matters |
|---|---|
| PPCM importer (`workers/importer.js`, empty) | **Required for phase 3** — benchmarks are computed from award history |
| Historical backfill | The reference calls this "what makes intelligence possible" |
| Detail enrichment (buyer, CPV, estimated value) | Needs the ARMEPS AJAX endpoints or Playwright; the notice pages are not server-rendered |
| Document download + text extraction | Needs `prepareAnonymousDownload.do` + a `jsessionid` cookie jar; feeds the phase-4 AI checklist |
| Non-ARMEPS notices | Direct-attachment notices (ZIP on gnumner) are counted and skipped — known, quantified coverage loss |

### 5. Phases 2–6

No code. In dependency order: matcher + notifier (needs `tenders` + `saved_searches`) →
benchmarks (needs `awards`, so needs the PPCM importer first) → workflow → billing.

---

## Assumed by the reference, absent here

These sit outside the phase list but the reference specifies all of them.

| Area | State |
|---|---|
| **Tests** | **none** — `tests/` exists but is empty; no runner in `devDependencies`. The reference has a whole `/testing` section. The listing-parser fixture test is the one that would catch a gnumner redesign |
| **API layer** | none — reference `/api` specifies endpoints, pagination, filtering, sorting, versioning, rate limits, webhooks, error codes |
| **Frontend** | none — reference specifies a Next.js + Tailwind client |
| **CI/CD** | none — no `.github/`, despite `/deployment` covering GitHub Actions |
| **Containerisation** | none — no `Dockerfile`, no `docker-compose.yml`. MinIO currently runs as a hand-started podman container that will not survive a reboot |
| **Scheduler registration** | `queues/scheduler.js` is written but has never been run; the repeatable sweep job is **not registered**. All runs so far were manually enqueued |
| **Dead code** | `src/queue.js` still exports the placeholder `ingestionQueue` that `app.js` imports; superseded by `src/queues/index.js` |

---

## Deliberate deviations from the reference

Not omissions — decisions, recorded so they are not mistaken for gaps.

| Reference says | TenderIQ does | Why |
|---|---|---|
| Prisma | **Knex** + hand-written migrations | Explicit SQL, no hidden queries; repositories are the only DB layer |
| Zod validation | **Joi** | Already a dependency |
| Feature-first folders (`features/*`) + `container.js` | Layer-first (`utils/`, `repositories/`, `workers/`, `libs/adapters/`) | Fewer moving parts at this size; the seams that matter (storage port, source adapters, repositories) are intact |

---

## Recommended next step

**Write the normalizer.** It converts 135 dead payloads into real tenders and unblocks
discovery, alerts, and intelligence in one move. Nothing else in the backlog changes what the
product can do as much for as little code.

After that, in order: freshness monitor (protect what you just built) → Phase 0 middleware +
auth (unblock the API) → PPCM importer + backfill (unblock intelligence).
