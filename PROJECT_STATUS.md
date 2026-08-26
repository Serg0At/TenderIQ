# Project Status — Gap Analysis

> Where TenderIQ stands against the reference specification at
> `CRM/gov-tender-monitoring/docs`, in particular its
> [backend build guide](../CRM/gov-tender-monitoring/docs/backend/build-guide/README.md)
> phases 0–6.
>
> **Assessed:** 2026-08-21 · against the live codebase and the live Neon database.
>
> Companions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
> [docs/SCRAPER_WORKFLOW.md](docs/SCRAPER_WORKFLOW.md) ·
> [docs/PROSPECT_FEASIBILITY.md](docs/PROSPECT_FEASIBILITY.md)

---

## The headline

```
source_payloads = 6261   tenders = 2590   parties = 1442   tender_lots = 3210
awards = 17051           public_tender_bids = 65075        tender_documents = 329
```

**Ingestion, the API foundation, and discovery all exist.** The pipeline runs end to end —
listing sweep → detail fetch → normalize → invitation archive → match → alert — behind an
authenticated, rate-limited, role-gated HTTP API.

The historical seed is **mid-run**: page 49 of 982, so the figures above are roughly **2.5% of
the eventual corpus** (~29,000 tenders, ~230k awards, ~773k bids). Everything downstream of
ingestion is being built against a sample, not the finished dataset.

`public_tender_bids` remains the thing the reference specification did not expect to be
obtainable: 13,837 rows of *who else bid and what they offered*, scraped from the public
`Գնառաջարկներ` ledger with no PPCM dependency. That is the entire feedstock for phase 3.

---

## Scorecard

| Phase | Reference scope | State |
|---|---|---|
| **0 — Foundation** | repo, config, entrypoints, middleware, auth, seed, health check | **done** |
| **1 — Ingestion** (moat feedstock) | scraper, normalizer, backfill, documents, freshness | **done — seed running** |
| **2 — Discovery** (the hook) | SavedSearch, tender API, matcher, notifier, reminders | **built — Telegram delivers** |
| **3 — Intelligence** (the moat) | price benchmarks, buyer/supplier profiles | **built** — benchmarks, competitor prices, profiles, AI recommendation |
| **4 — Bid workflow** (the glue) | pipeline, vault, AI checklist, tasks | **0%** |
| **5 — Accounts & billing** | plans, subscriptions, invoices, bank transfer | **schema + seeded plans only** |
| **6 — Post-award & polish** | contracts, win/loss, exports, admin dashboard | **0%** |

There is **no frontend of any kind**. Everything below is API-only.

---

## Phase 0 — Foundation · done

| Item | State |
|---|---|
| Express + PostgreSQL + Redis + BullMQ + MinIO stack | done |
| `variables.config.js` — validates env, refuses to boot on a bad value | done |
| `middlewares/auth.js` — JWT verify, `TOKEN_EXPIRED` distinct from `UNAUTHENTICATED` | done |
| `middlewares/authorize.js` — role matrix + plan entitlement, default-deny | done |
| `middlewares/validate.js` — Joi at the HTTP boundary, `stripUnknown` | done |
| `middlewares/error.js` — one error envelope; unexpected errors become `INTERNAL_ERROR` + log ref | done |
| `middlewares/rateLimit.js` — Redis-backed, per-user then per-IP, fails open | done |
| Auth flows — register / login / refresh (rotation + reuse detection) / logout / me | done |
| `npm run seed` — 5 roles, 5 plans | done |
| `GET /api/v1/health` — shares `checkHealth()` with the scheduled monitor | done |

The permission matrix is verified case by case: `owner` holds `billing:manage` and `admin` does
not; `viewer` cannot write a bid; a free plan blocks `intelligence:read` for **every** role
including owner; an unknown role is denied.

Refresh-token reuse revokes the whole family — replaying a consumed token kills the legitimately
rotated one too, which is the correct reading of an ambiguous theft signal.

---

## Phase 1 — Ingestion · done, seed in progress

Working: `source.sweep` (tid watermark) → `tender.detail` → `normalize.tender` writing
`tenders` / `parties` / `awards` / `public_tender_bids` / `tender_lots`; `tender.refresh`
re-checking unsettled tenders hourly; `tender.documents` extracting CPV, buyer tax ID and per-lot
item text from the invitation archive; `backfill.js` seeding the archive on its own queue and
process; `health.check` every 5 minutes.

| Item | State |
|---|---|
| Historical seed | **running** — page 49/982, resumable, `backfillDocuments: false` |
| Freshness + DLQ + backlog monitor | done — was the last unbuilt item in the reference build order |
| `npm run reindex` | rebuilds `source_payloads` from object storage — makes schema changes cheap |
| `npm run documents:backfill` | fetches invitations the normalizer never enqueued |
| Coverage metric (NFR-DATA-2) | **dropped by decision** — signals emitted, nothing consumes them |
| Parser fixture tests | **dropped by decision** — no test runner in the project |

### Known coverage limits

- **e-auctions only.** `procedure_type` is always `e_auction`; open competition, quotation,
  single-source and restricted procedures are not ingested. Adding them means the gnumner
  notice board as a second source.
- **CPV and buyer tax ID are sparse** — 264 of 724 tenders and 114 of 690 parties. Both exist
  only inside the invitation archive, and the seed skips archives while `backfillDocuments` is
  false. Run `npm run documents:backfill` in batches to close the gap.
- **PPCM was removed**, not deferred: it is an AngularJS SPA at armeps.am/ppcm, not the CSV feed
  the reference assumes, and the bid ledger already supplies the award data it existed for.
  `contracts` therefore has no writer and stays empty until phase 6.

---

## Phase 2 — Discovery · built, one gap

| Item | State |
|---|---|
| `GET /tenders` — CPV (incl. per-lot), keyword, buyer, region, value, procedure, status, deadline | done |
| Cursor pagination with id tiebreaker | done |
| `GET /tenders/:id` — detail with lots and documents | done |
| Saved-search CRUD, tenant-scoped | done |
| Matcher — hierarchical CPV + keyword scoring, region/value as hard filters | done |
| Notifications + per-channel delivery tracking + dedupe | done |
| Deadline reminders at 72h and 24h | done |
| Amendment re-notification with a change summary | done |
| **Delivery channels** | **Telegram live** — link flow, quiet hours, auto-revoke. email/viber still `failed` |
| Daily digest | not built |
| Relevance ranking of the tender list | not built (scoring exists, drives alerts only) |

**The hook reaches a user once a bot token is set.** Telegram is built end to end: an org mints a
`t.me/<bot>?start=<token>` deep link, the user opens it, the bot records the chat and alerts flow.
Quiet hours (BR-10) defer rather than drop, and a blocked bot or five consecutive failures revokes
the subscription instead of retrying forever.

Two things still needed to make it live: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME` from
@BotFather, and `npm run migrate:channels` on any environment other than this one.

Inbound updates run in `polling` mode by default because the project has no public HTTPS endpoint;
`TELEGRAM_MODE=webhook` plus `npm run telegram:webhook -- --set <url>` switches to webhooks. Polling
must run in exactly one process — set `TELEGRAM_MODE=off` on every worker replica but one.

**The spec's email fallback is not built**, because there is no email channel to fall back to. A
Telegram failure is recorded and, if permanent, revokes the chat; it does not reroute.

---

## Phase 3 — Intelligence · built

| Item | State |
|---|---|
| `GET /tenders/:id/benchmark` · `GET /benchmarks/:cpv` | done — tiered, materialised |
| **`GET /tenders/:id/competitor-prices`** | done — per-lot winner, price, every bidder named |
| `GET /competition` — expected bidder count | done — works on UNSETTLED tenders |
| `GET /suppliers/:id/profile` — the competitor profile | done |
| `GET /buyers/:id/profile` | done |
| `GET /tenders/:id/price-recommendation` | done — needs `ANTHROPIC_API_KEY` to explain |
| Buyer-specific benchmark materialisation | done — 44 pairs, pre-filtered in SQL |
| Nightly `profiles.recompute` + `benchmarks.recompute` | done — scheduled 03:23 / 04:41 |

Competitor prices are the headline because they need **no CPV**: keyed by tender id, they
work across the whole corpus rather than the third of it that has a category.

Profiles are read live from indexed single-party lookups, so they are correct the moment a
tender settles; the materialised rows exist for whole-population work (ranking, exports, the
AI evidence packet). The nightly rebuild is set-based — one query per aggregate, not one per
party, which took it from ~25 minutes to 4.8 seconds.

### Sample independence — the honesty gap in the comparables threshold

`sample_size` counts awards, and awards are **per lot**, so one multi-lot procurement can
clear `MIN_COMPARABLES` alone. Measured on the live corpus:

| categories clearing the 5-award threshold | 55 |
|---|---|
| ...drawn from fewer than 5 distinct tenders | **47** |
| ...drawn from exactly ONE tender | **15** |

CPV 33141205 reports 33 comparable awards that are 33 lots of a single buy. A median over
those is one observation, not 33 — precisely what the threshold exists to prevent.

`price_benchmarks.distinct_tenders` now records this and it is returned on every benchmark
and in the AI evidence packet, and the AI prompt is required to cap confidence at `low` when
it is thin. **The threshold itself is unchanged** — raising it to require independent tenders
would unpublish roughly 47 of 55 benchmarks, which is a product call, not a bug fix.

### Remaining

`tracked_tenders`, `bids`, `checklists`, `checklist_items`, `tasks`, `vault_documents`,
`contracts`, `subscriptions`, `invoices`, `audit_logs` still have **no writer**.

`src/workers/aiExtractor.js` is the only empty file left. Its input is already prepared:
the document stage stores ~250k characters of extracted invitation text per tender. The
Anthropic adapter it will use now exists at `src/libs/adapters/ai/anthropic.js`.

### The two decisions that were owed — both now made

1. **The comparables threshold** is `INTELLIGENCE.MIN_COMPARABLES = 5`, in
   `variables.config.js`. Below it every rate and every benchmark returns `insufficient_data`
   rather than a number. See the independence caveat above — 5 *awards* is not yet 5
   *procurements*.
2. **CPV coverage** was accepted as-is rather than blocking on the backfill. The decision that
   made that viable: competitor prices and win rates need no CPV, so the headline features work
   across the whole corpus. Only `categories` on a supplier profile and category benchmarks are
   CPV-gated, and both say so on the wire instead of returning a silently short answer.


---

## Data-quality rules learned the hard way

Two defects were found by comparing stored numbers against what they physically should be.
Neither was visible to schema, null or referential-integrity checks.

- **Awards must come from an ACCEPTED bid, not merely rank 1.** The source ranks rejected
  submissions too (`Մերժված`). Awarding on rank alone recorded 21% of awards to companies the
  buyer had thrown out, including a 6,666,600,000,000 AMD bid against a 75,000 budget — a real
  value published by the source, not a parse error.
  `TenderRepository.rebuildAwardsFromBids()` repairs this from stored bids with no re-crawl.
- **Money statistics must exclude rejected bids.** Including them put the average bid at
  317,831,314,144 AMD instead of 2,957,029 — a 107,000x error feeding ICP scoring. Participation
  and win/loss counts still count rejects, because being rejected is still bidding and still
  losing.

**Sanity checks to re-run after the seed finishes** — all three held at the last check:

| check | expected |
|---|---|
| awards backed by a rejected bid | **0** |
| average winning discount vs budget | ~15–25% (currently 16.2%) |
| largest single award | hundreds of millions AMD, not trillions |

Also note: **workers must be restarted after a code change.** Node does not hot-reload, so a
long-running worker keeps writing with the logic it booted on — which is how the rejected-bid
defect reappeared after being fixed.

---

## Recommended next step

**Set `ANTHROPIC_API_KEY`.** The price-recommendation endpoint is built, gated and tested
against stubbed model responses, but has never made a live call — it currently answers
`evidence_only` and returns the numbers without the narrative.

Then, in order:

1. **One real alert channel (Telegram).** Discovery still does not reach a user; every
   channel returns `failed`. This is the oldest unblocked item.
2. **A frontend.** Everything in phase 3 is API-only, and competitor prices are a table —
   the feature is close to unusable without a screen.
3. **`npm run documents:backfill` over the corpus**, which widens CPV coverage and with it
   category benchmarks and supplier `categories`.
4. **Revisit sample independence** once the seed finishes. The 47-of-55 figure above is
   measured on 2.5% of the eventual corpus and should improve on its own; if it does not,
   requiring distinct tenders in the threshold becomes the right call.
