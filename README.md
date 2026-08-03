# TenderIQ

> **Bid intelligence for suppliers who bid on public tenders.**
> Armenia first, OCDS-region expansion later.

TenderIQ is a private SaaS tool used only by suppliers — the companies that bid on public
tenders. It helps them discover the right tenders, see what competitors won at, prepare
compliant bids, and never miss a deadline.

It is not a procurement platform and does not replace ARMEPS, the Armenian government
e-procurement system. It reads public procurement data at a polite rate, normalizes it into an
OCDS-aligned model, and turns it into something a supplier can act on.

---

## Status

Early. Ingestion works end to end; nothing downstream of it exists yet.

Raw ARMEPS notices are fetched, stored, and provably deduped. They have not yet become domain
entities — `src/workers/normalizer.js` is empty, and every feature reads from `tenders`. That
one file is the highest-leverage work in the repo.

| Phase | State |
|---|---|
| 0 — Foundation | partial |
| 1 — Ingestion | partial |
| 2 — Discovery | not started |
| 3 — Intelligence | not started |
| 4 — Bid workflow | not started |
| 5 — Accounts & billing | not started |
| 6 — Post-award & polish | not started |

The schema for all phases exists. The application code does not. A file-by-file gap analysis,
ordered by what blocks what, is in [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md).

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

Node.js 20+ (ESM) · Express 5 · PostgreSQL via Knex · Redis + BullMQ · S3-compatible object
storage · `axios`/`cheerio` for scraping · Joi · JWT · winston · Claude API. Next.js frontend
planned.

The reference specification calls for Prisma and Zod; this codebase uses Knex and Joi. Both are
deliberate — the reasoning is recorded in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

### Scripts

| Script | Does |
|---|---|
| `npm run dev` | API with nodemon |
| `npm run worker` / `worker:dev` | Worker process |
| `npm run scheduler` | Register repeatable jobs, then exit |
| `npm run migrate:up` / `migrate:down` | Create / drop the schema |

---

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, boundaries, layering, folder structure, data model, queue topology |
| [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md) | Gap analysis against the reference spec, ordered by what blocks what |
| [docs/SCRAPER_WORKFLOW.md](docs/SCRAPER_WORKFLOW.md) | The ingestion pipeline stage by stage |
| [docs/SCRAPER_BUILD_GUIDE.md](docs/SCRAPER_BUILD_GUIDE.md) | How to build a new source adapter |

The full product and engineering specification — business, product, database, API, security, AI,
testing, deployment, operations, UX — lives in a separate documentation repository.
