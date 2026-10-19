# Scraper Workflow

> How raw public-procurement data becomes normalized, deduped OCDS entities in Tendra.
> Companion document: [ARCHITECTURE.md](ARCHITECTURE.md).

## Purpose

Define the end-to-end ingestion pipeline: what triggers a scrape, what each stage does, where
data lands, how failures are contained, and which knobs control behaviour.

Ingestion is the moat. Everything else in Tendra (discovery, alerts, price intelligence, bid
workflow) is a read model over what this pipeline produces. A missed tender is the single
failure mode customers churn over, so the workflow is designed around **idempotency,
raw-payload retention, and freshness alerting** rather than raw throughput.

---

## Sources

Configured in [src/configs/sources.config.js](src/configs/sources.config.js). Each source is a
self-contained adapter — when a site changes layout, exactly one parser file changes.

| Key | Kind | Cadence | Produces |
|---|---|---|---|
| `armeps` | HTML scrape of eauction board | `*/5 * * * *` sweep, `17 * * * *` result re-check | `tenders`, `parties` (buyer **and** supplier), `awards`, `public_tender_bids` |
| `ppcm` | **parked** — AngularJS SPA, not a file export | — | would add `contracts` only |
| `ocds` *(2027)* | OCDS JSON feed | TBD | replaces `armeps` upstream; downstream unchanged |

Per-source knobs: `enabled`, `baseUrl`, `listingCron`, `refreshCron`, `rateLimit`, `concurrency`,
`maxListingPages`, `refreshWindowDays`, `maxRefreshBatch`, `downloadDocuments`.

There is deliberately no `lookbackHours` on `armeps`: the eauction listing table has no publish-date
column, so depth is driven by the tid high-water mark instead (stage 3).
Cross-source defaults live under `config.SCRAPER` in
[src/configs/variables.config.js](src/configs/variables.config.js).

---

## Pipeline overview

```mermaid
flowchart TB
    CRON[Scheduler<br/>listingCron per source] -->|source.sweep| Q1[(ingest.fetch)]
    Q1 --> SCR[scraper worker]
    SCR -->|listing.page x N| Q1
    SCR -->|tender.detail| Q1
    SCR --> RAW[(Object storage<br/>raw/)]
    SCR --> SP[(source_payloads)]
    SCR -->|normalize.tender| Q2[(ingest.normalize)]
    SCR -->|document.download| Q3[(ingest.documents)]

    Q3 --> DOC[document worker]
    DOC --> TD[(Object storage<br/>tender-docs/)]
    DOC --> TDB[(tender_documents)]

    IMP_CRON[Scheduler<br/>daily] -->|import.ppcm| Q1
    Q1 --> IMP[importer worker]
    IMP --> RAW
    IMP -->|normalize.award| Q2

    Q2 --> NORM[normalizer worker]
    NORM --> PG[(PostgreSQL<br/>OCDS-aligned)]
    NORM -->|TenderIngested / TenderAmended / AwardIngested| EV[(events)]

    SCR -.exhausted.-> DLQ[(dead-letter)]
    NORM -.exhausted.-> DLQ
    DLQ --> ALERT[Ops alert]
```

---

## Stage by stage

### 1. Schedule — `source.sweep`

The scheduler process reads `listEnabledSources()` and registers one BullMQ repeatable job per
source using its `listingCron`. The job ID is derived from the source key, so restarting the
scheduler re-registers rather than duplicates.

A sweep job carries:

```js
{ source: 'armeps', mode: 'incremental', since: <now - lookbackHours>, cursor: null }
```

`mode: 'backfill'` overrides `lookbackHours` with an explicit date range and is enqueued at low
priority so a multi-year backfill never starves live notices.

### 2. Politeness gate

Before any outbound request the scraper checks, in order:

1. **Rate limit** — a Redis token bucket keyed `ratelimit:{source}`, sized from the source's
   `rateLimit: { requests, perMs }`. Exhausted bucket → the job is delayed, not failed.
2. **Concurrency** — the BullMQ worker for a source runs with `concurrency` from its config.

There is no robots.txt check: none of the crawled hosts serves one, and each returns its 404 as an
HTML page rather than a 404 status. Politeness rests entirely on the rate limit plus the honest bot
identity in `SCRAPER.USER_AGENT`. A future source that does publish crawl rules needs this decision
revisited.

Identity is always the declared bot UA (`TendraBot/1.0 (+https://Tendra.am/bot; …)`). The
scraper does not rotate user agents, spoof browsers, or bypass access controls — it reads
public pages at a polite rate and identifies itself.

### 3. Listing sweep — `listing.page`

> **Verified 2026-08-03:** gnumner sends **no `ETag`, no `Last-Modified`, no `Cache-Control`** —
> only `Server: Apache` and a content type. Conditional GET therefore never returns 304 from
> this source. The code still sends the headers (it costs nothing and PPCM may honour them),
> but sweep economy comes entirely from the early-stop rule below, not from 304s.

Pagination is *chained*: each page's handler decides whether to enqueue the next one.

1. HTTP GET via `axios` with `SCRAPER.HTTP_TIMEOUT_MS`, sending `If-None-Match` /
   `If-Modified-Since` when the source supports them.
2. Decode with `iconv-lite` when the response declares a non-UTF-8 charset.
3. Parse rows with `cheerio` → `{ sourceId, url, title, publishedAt, deadlineAt }`.
4. **Two notice types.** The board mixes ARMEPS e-procurement notices (linking to
   `armeps.am/...?resourceId=N`) with direct-attachment notices (a ZIP hosted on gnumner —
   Gazprom Armenia open-offer requests, ministry quotation requests). Only the first kind has a
   stable id; v1 skips the second and *counts* it, so coverage loss is visible rather than
   silent. The parser returns `blocksSeen` and `skipped` alongside `rows` for exactly this.
5. **Continue to page N+1 only while the page still holds notices newer than `since`.**
   The board is a 9-year archive reaching back to 2017, so `lookbackHours` — not
   `maxListingPages` — must be the depth control. A routine sweep touches 1–2 pages; a
   post-outage sweep goes as deep as the window requires, with no config change. Loading
   history is a deliberate backfill with its own date range.
6. Enqueue one `normalize.tender` job per row whose fingerprint changed.

**Browser fallback.** If the parser yields zero rows on a page that returned HTTP 200 and the
markup contains a known JS-app marker, the job re-runs through Playwright with
`SCRAPER.BROWSER_TIMEOUT_MS`. Playwright is an `optionalDependency` — if it is not installed the
job fails loudly rather than silently returning nothing.

### 4. Detail fetch — `tender.detail`

1. Fetch the notice page (same politeness gate).
2. `hash = sha256(body)`.
3. Look up `source_payloads` by `(source, ref)`. **Same hash → stop.** Nothing downstream runs;
   this is the cheap idempotency check that makes the whole pipeline safe to re-run.
4. New or changed → write the body to object storage at
   `rawKey({ source, ref, hash, ext })` → `raw/{source}/{ref}/{hash}.html`.
5. Insert a `source_payloads` row `{ source, ref, storage_key, hash, fetched_at }`.
6. Enqueue `normalize.tender` with `{ source, ref, hash, storageKey }`.
7. If `source.downloadDocuments`, enqueue one `document.download` per attachment link.

Raw payloads are **kept forever**. When a parser improves, normalization is replayed from
storage — no re-crawl of the source.

### 5. Document download — `document.download`

1. Stream the attachment, aborting past `SCRAPER.MAX_DOCUMENT_BYTES` (60 MB default).
2. `hash = sha256(bytes)` → dedupe: an identical attachment shared by many tenders is stored once.
3. Store at `tenderDocKey({ source, sourceId, hash, ext })` → `tender-docs/{source}/{sourceId}/{hash}.{ext}`.
4. Extract text from PDFs with `pdf-parse`; store alongside at `tenderDocTextKey(...)` (`.txt`).
5. Upsert `tender_documents` `{ tender_id, url, storage_key, kind, parsed }`.
6. Extracted text is the input for the `checklist.extract` (spec → checklist) job; it is treated
   strictly as **data, never as instructions**, no matter what the document says.

#### What is inside the invitation archive — and what is not read

Only `hraver.docx` is opened. That is deliberate, but the reason is worth writing down, because
the archive looks like it holds much more than the stage takes from it. One measured example
(tid 47009, a 15.2 MB archive):

```
    180,247  hraver.docx                      ← the only entry parsed
    140,609  hraver_ru.docx                   ← Russian translation of the same
  2,987,022  lot_1_i_texnikakan_bnutagir.zip  ┐
  2,987,022  lot_2_i_texnikakan_bnutagir.zip  │ "per-lot technical specification"
  2,987,022  lot_3_i_texnikakan_bnutagir.zip  ├ all five are BYTE-IDENTICAL —
  2,987,022  lot_4_i_texnikakan_bnutagir.zip  │ one sha256 across all of them
  2,987,022  lot_5_i_texnikakan_bnutagir.zip  ┘
```

Three findings that would change how anyone approaches these:

- **"Per-lot" is not per-lot.** All five spec archives had one content hash. Parsing them
  per lot would decode the same bytes five times and attribute one document to five different
  lots. Dedupe by content hash first; the lot in the filename is not evidence of lot-specific
  content.
- **98% of the payload is boilerplate.** Inside each: `ՏԲ.docx` at 23 KB — the actual technical
  specification — and `Հուշաթերթ_Памятка_merged.pdf` at 3.1 MB, a generic bilingual memo
  repeated across tenders. The useful content is the small file.
- **The formats vary wildly and include `.rar`.** Across 43 sampled entries: 18 `.xls`,
  11 `.rar`, 11 `.docx`, 3 `.xlsx` (see the header comment in
  `libs/adapters/source/armeps/invitation.parser.js`). `adm-zip` cannot read `.rar`, so roughly
  a quarter of them need a decoder that is not currently a dependency. That, not the parsing,
  is the real cost of this work.

**Status: not built, and nothing reads them.** The parser's header comment says these entries
"feed the later AI checklist" — that is the intent, not the current behaviour. The checklist
stage reads only the `.txt` derived from `hraver.docx`. Wiring the technical specifications in
would sharpen it, and the natural destination is a **lot-level** field, not `tenders.description`.

#### `tenders.description` has no source and is never written

`normalize.tender` sets it to `null` unconditionally, and `applyInvitationFacts` — the only
other writer — has no parameter for it. The comment beside it in `workers/normalizer.js` pairs
it with `cpvCode` and promises both arrive at "a later stage"; that promise is kept for CPV and
never kept for `description`.

There is no tender-level description to keep it with. Measured on tid 47009: the docx's contract
subject line reads «...կնքել **Անվադողեր** մատակարարման պայմանագիր», and `tenders.title`
(`Վերնագիր` on the detail page) is already `Անվադողեր` — the same string. The detail page has
**11 labels total** and none of them is descriptive. The genuinely descriptive content is per
lot and is already stored in `tender_lots.name` (`"185/65 R15 ձմեռային։"`, `"8.25/R20,
համասեզոնային անվախցիկով (լրակազմ)։"`, ...).

So the column is an OCDS-shaped leftover: everything it could hold is either a duplicate of
`title` or belongs on `tender_lots`. **Open decision — drop it, or leave it null.** Do not fill
it by joining lot names; that is a derived copy of data `tender_lots` already owns.

### 6. Normalization — `normalize.tender` / `normalize.award`

The only stage that writes domain entities. Runs in its own queue so a parser bug can be fixed
and replayed without re-fetching.

1. Read the raw payload from storage by `storageKey`.
2. Map source fields → OCDS-aligned entities: `parties` (buyer), `tenders`, and for the importer
   `awards` / `contracts`.
3. Validate the mapped record with `joi`. Invalid → DLQ with the payload key attached; never a
   partial write.
4. **Upsert `tenders` by `source_id`** (unique index) inside a transaction.
5. **Amendment detection** — compare a canonical field hash (deadline, value, CPV, status, spec
   refs) against the stored latest version:
   - unchanged → touch `fetched_at` only, emit nothing;
   - changed → set previous row `is_latest = false`, insert a new row with `version + 1` and
     `is_latest = true`, emit `TenderAmended` with the field diff.
6. Emit `TenderIngested` (new) or `TenderAmended` (changed) / `AwardIngested`.

Downstream consumers — matcher, notifier, intelligence recompute — are separate workers
subscribed to those events, and are out of scope for this document.

### 7. PPCM import — parked, not built

The steps previously described here (download the daily CSV/Excel export, hash the file, stream
rows) described a source that does not exist in that form. Verified 2026-08-16:

- PPCM is **"Procurement Plan & Contracts Management"**, served at `armeps.am/ppcm` — **not**
  `gnumner.minfin.am`, which is what `sources.config.js` claimed.
- It is an **AngularJS SPA** (`#/report/<uuid>`). `/ppcm/public/contracts` and
  `/ppcm/public/bid-report` both return the app shell as `text/html`, so ingesting it requires
  reverse-engineering its XHR API or driving a headless browser.
- The reference spec never enumerates a single PPCM column; it records the question as open
  (`research/Open Questions.md` Q4, *"Exactly what award data is public and when?"*).

**Award history no longer depends on it.** Stage 4 parses the `Գնառաջարկներ` ledger off every
finished tender's detail page — per lot: every bidder, rank, budget price, initial and final offer,
VAT, accepted/rejected — which is finer-grained than a tender-level export. That writes `awards`,
`public_tender_bids` and supplier `parties` directly.

PPCM's one unique contribution is **signed contract values**, which can diverge from the auction's
final offer after renegotiation. That feeds post-award (phase 6); `contracts` stays empty until then.

---

## Idempotency model

Every stage is safe to re-run, which is what makes at-least-once queue delivery acceptable.

| Stage | Idempotency key | Effect of a repeat |
|---|---|---|
| `source.sweep` | cron job ID | overlapping sweep is skipped by a Redis lock |
| `listing.page` | `(source, page, etag)` | `304` → no work |
| `tender.detail` | `(source, ref, hash)` | known hash → no storage write, no enqueue |
| `document.download` | content hash | same object key → overwrite-in-place, one DB row |
| `normalize.tender` | `tenders.source_id` + field hash | upsert; no new version unless fields changed |
| `import.ppcm` | file hash, then award reference | row-level upsert |

Storage keys are deterministic by design: a retried job writes the *same* key, so a partial
failure leaves a correct object rather than a duplicate.

---

## Failure handling

```mermaid
flowchart LR
    JOB[Job] --> RUN{run}
    RUN -->|ok| DONE[complete]
    RUN -->|transient: 5xx, timeout, ECONN| BACK{attempts <br/> < MAX_ATTEMPTS?}
    BACK -->|yes| DELAY[backoff: BASE * 2^n, capped at MAX] --> JOB
    BACK -->|no| DLQ[(dead-letter)]
    RUN -->|permanent: 404, schema invalid| DLQ
    RUN -->|429| PAUSE[delay source, no attempt burned]
    DLQ --> OPS[Ops alert + parser fix]
```

- Attempts and backoff come from `SCRAPER.MAX_ATTEMPTS` (5), `SCRAPER.BACKOFF_BASE_MS` (2 s),
  `SCRAPER.BACKOFF_MAX_MS` (120 s).
- `429` **delays** the source rather than consuming an attempt — being rate-limited is not a job
  failure.
- Schema-invalid records go straight to DLQ with their raw storage key, so the fix is: patch the
  parser, replay from storage.
- DLQ depth is a monitored metric; growth means a source changed shape.

### Freshness monitoring

`SCRAPER.FRESHNESS_SLA_MINUTES` (15) encodes NFR-DATA-1.

> **Correction.** An earlier version of this document said to compare
> `max(source_payloads.fetched_at)` against now. **That is wrong.** Unchanged content is
> deliberately never inserted, so that value reports the last *change*, not the last successful
> *fetch* — a healthy source that simply published nothing for an hour would look dead and page
> someone at 3am. Sweep health is a separate signal: the worker writes a Redis key
> `sweep:ok:{source}` on every successful page, read via `lastSuccessfulSweep(source)`.

The monitor compares that key against now:

| Condition | Severity |
|---|---|
| Lag > SLA | P1 — pipeline is silently broken |
| Sweep returned **zero** rows on a source that normally returns rows | P1 — parser drift |
| DLQ depth rising | P2 |
| Coverage (ingested vs. source-reported count) drops | P1 |

Zero results are the dangerous case: the pipeline "succeeds" while ingesting nothing. That is
why zero-row sweeps alert rather than log.

---

## Configuration reference

| Setting | Where | Default | Controls |
|---|---|---|---|
| `SCRAPER_USER_AGENT` | env | `TendraBot/1.0 …` | bot identity sent on every request |
| `SCRAPER_HTTP_TIMEOUT_MS` | env | `30000` | axios timeout |
| `SCRAPER_BROWSER_TIMEOUT_MS` | env | `60000` | Playwright fallback timeout |
| `SCRAPER_MAX_ATTEMPTS` | env | `5` | retries before DLQ |
| `SCRAPER_BACKOFF_BASE_MS` / `_MAX_MS` | env | `2000` / `120000` | exponential backoff |
| `SCRAPER_MAX_LISTING_PAGES` | env | `200` | global pagination ceiling |
| `SCRAPER_MAX_DOCUMENT_BYTES` | env | `62914560` | attachment size cap |
| `SCRAPER_FRESHNESS_SLA_MINUTES` | env | `15` | freshness alert threshold |
| `rateLimit`, `concurrency`, `lookbackHours`, `maxListingPages`, `downloadDocuments` | `sources.config.js` | per source | per-source politeness and depth |
| `STORAGE_DRIVER` | env | `s3` | `s3` (MinIO/AWS) or `local` for dev |

---

## Operational scenarios

**Source changes layout.** Listing sweep returns zero rows → freshness monitor fires P1 → fix
the one parser file → replay `normalize.tender` from retained raw payloads. No re-crawl, no data
loss, API unaffected.

**Historical backfill.** Enqueue `import.ppcm` with an explicit date range at low priority.
Live `ingest.fetch` and alert dispatch keep their own lanes, so the 5-minute freshness SLA holds
while years of awards load.

**Deadline amendment.** A tender's deadline moves → detail hash changes → normalizer versions
the row (`is_latest` flips) and emits `TenderAmended` → notifier re-alerts everyone tracking it
with the diff.

**Redis outage.** Producers fail fast, queues are durable, workers resume on recovery. The API
keeps serving last-known data from PostgreSQL.

**2027 OCDS migration.** Armenia's OCDS platform launches 2027-01-01. Only the source adapter
and its parser change: raw storage, normalization contract, entities, events, and every
downstream consumer stay as they are.

---

## Current implementation status

| Piece | State |
|---|---|
| `sources.config.js`, `variables.config.js` (SCRAPER/STORAGE) | done |
| Storage port + S3/local drivers, deterministic key helpers | done |
| Schema + composite unique `(source, ref, hash)` on `source_payloads` | done |
| `utils/{logger,hash,http,rateLimiter}.js` | done, verified live |
| ARMEPS adapter: `listing.parser.js` + `client.js` | done, verified live |
| `repositories/sourcePayload.repo.js` | done |
| `queues/{names,index,scheduler}.js` | done |
| `workers/{scraper,index}.js` — sweep + chained listing pagination | **done, proven idempotent** |
| `importer` / `normalizer` / `aiExtractor` workers | empty stubs |
| Detail-page enrichment (buyer, CPV, value), document download | not started — needs the AJAX endpoints or Playwright |
| Freshness monitor, DLQ alerting | not built — the `sweep:ok:{source}` signal it needs exists |

**Verified end-to-end 2026-08-03** against the live source: cold start ingested 116 notices;
a repeat sweep fetched 1 page, wrote 0 rows and enqueued 0 jobs.

Remaining build order: normalizer (raw → `tenders`/`parties`) → freshness monitor → PPCM
importer → detail enrichment.

---

## References

- [ARCHITECTURE.md](ARCHITECTURE.md) — components, layering, folder structure
- [src/configs/sources.config.js](src/configs/sources.config.js) — per-source adapter config
- [src/libs/storage/index.js](src/libs/storage/index.js) — storage port and key scheme
- [migrations/create_table.js](migrations/create_table.js) — OCDS-aligned schema
