# Tendra

> **Bid intelligence for suppliers who bid on public tenders.**
> Armenia first, OCDS-region expansion later.

Tendra is a private SaaS tool used only by suppliers — the companies that bid on public
tenders. It helps them discover the right tenders, see what competitors won at, prepare
compliant bids, and never miss a deadline.

It is not a procurement platform and does not replace ARMEPS, the Armenian government
e-procurement system. It reads public procurement data at a polite rate, normalizes it into an
OCDS-aligned model, and turns it into something a supplier can act on.

---

## Status

The backend runs end to end: ingestion from every Armenian source, discovery and alerts,
intelligence, the bid pipeline, multi-user organizations. Subscriptions are being built; card
payments, post-award and the frontend do not exist yet.

| Phase | State |
|---|---|
| 0 — Foundation | done |
| 1 — Ingestion | done — e-auction, ARMEPS and paper tenders, with results |
| 2 — Discovery | done — search, filters, relevance ranking, saved searches, Telegram and email alerts |
| 3 — Intelligence | done — price benchmarks, competitor prices, expected competition, buyer and supplier profiles, AI price recommendation |
| 4 — Bid workflow | done — pursuit pipeline, draft and locked bids, win/loss reconciliation, AI checklist, document vault |
| 5 — Accounts & billing | partial — multi-user organizations done; trial and promo subscriptions in progress; card payments not started |
| 6 — Post-award | not started |

There is no test suite and no frontend yet (a Next.js client is planned).

---

## Data sources

Three submission channels, assembled from four sources
([ADR 0004](docs/adr/0004-tender-identity-across-sources.md)):

| Source | Provides |
|---|---|
| `eauction.armeps.am` | e-auction tenders, their invitation archives and public bid ledgers |
| `gnumner.minfin.am` | discovery of ARMEPS and paper tenders; paper invitations, amendments, contract and failure notices |
| `armeps.am` | ARMEPS tender detail and document sets |
| PPCM | results of ARMEPS tenders; bidders' tax IDs; a sweep for tenders Tendra never saw |

Each source is one adapter under [src/libs/adapters/source/](src/libs/adapters/source/), so a
site redesign is one parser to change. Raw payloads are kept forever and normalization replays
from storage — a parser fix never needs a re-crawl. The pipeline, stage by stage:
[docs/SCRAPER_WORKFLOW.md](docs/SCRAPER_WORKFLOW.md).

---

## Architecture

Modular monolith — one repo, one dependency graph, clear internal seams. Three processes share
the codebase:

| Process | Entry | Responsibility |
|---|---|---|
| API | [src/server.js](src/server.js) | HTTP, auth, tenant isolation, business logic |
| Workers | [src/workers/index.js](src/workers/index.js) | BullMQ processors: ingestion, AI, notifications |
| Scheduler | [src/queues/scheduler.js](src/queues/scheduler.js) | Registers repeatable jobs, then exits |

Workers are split from the API deliberately: scraping is the fragile part of the system, and a
parser blowing up on a redesigned page must never affect request handling.

Two rules carry most of the weight:

1. **Only repositories touch the database.** No Knex in services, controllers, or workers.
2. **Only the storage port touches object storage.** Nothing imports the AWS SDK directly.

Components, layering, folder structure, queue topology, and trade-offs:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Stack

Node.js 20+ (ESM, no build step) · Express 5 · PostgreSQL 15+ via Knex · Redis + BullMQ ·
S3-compatible object storage · `axios`/`cheerio` for scraping · Joi · JWT · Nodemailer ·
Telegram Bot API · winston · Claude API.

The reference specification calls for Prisma and Zod; this codebase uses Knex and Joi. Both are
deliberate — the reasoning is recorded in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Running locally

```bash
docker compose up -d     # Redis, MinIO and its bucket
npm install
npm run migrate:up       # create the schema (Postgres 15+; it installs btree_gist)
npm run seed             # roles and plans — run before anyone registers
npm run scheduler        # register the repeatable sweeps in Redis
npm run dev              # API
npm run worker:dev       # workers, in a second terminal
```

Postgres is not in the compose file — point `PSQL_*` at a local server or Neon. Every
environment variable is declared, defaulted and validated in
[src/configs/variables.config.js](src/configs/variables.config.js), which refuses to boot on a
bad value; per-source scraping knobs live in
[src/configs/sources.config.js](src/configs/sources.config.js).

### Scripts

| Script | Does |
|---|---|
| `npm run dev` | API with nodemon |
| `npm run worker` / `worker:dev` | Worker process |
| `npm run scheduler` | Register repeatable jobs, then exit — a deploy step, not a daemon |
| `npm run migrate:up` / `migrate:down` | Create / drop the entire schema |
| `npm run seed` | Reference data (roles, plans); idempotent |
| `npm run backfill:start` / `backfill` | Seed the historical archive / resume it |
| `npm run normalize:replay` | Re-normalize every tender from storage after a parser fix |
| `npm run sources:verify` | Report the source merge rules against real data; writes nothing |

The maintenance scripts (`documents:*`, `cpv:backfill`, `buyers:merge`, `notices:*`,
`relevance:backtest`, …) are described one by one under `scriptsDescriptions` in
[package.json](package.json).

---

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, boundaries, layering, folder structure, data model, queue topology |
| [docs/SCRAPER_WORKFLOW.md](docs/SCRAPER_WORKFLOW.md) | The ingestion pipeline stage by stage, idempotency and failure model |
| [docs/API_REFERENCE.md](docs/API_REFERENCE.md) | Every `/api/v1` endpoint, the envelope, authorization gates and error codes |
| [docs/AI_COST_MODEL.md](docs/AI_COST_MODEL.md) | What each AI feature costs, cost levers, quota design |
| [CONTEXT.md](CONTEXT.md) | Domain glossary |
| [docs/adr/](docs/adr/) | Architecture decision records |

The full product and engineering specification — business, product, database, API, security, AI,
testing, deployment, operations, UX — lives in a separate documentation repository.
