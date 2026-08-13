# Building the First Scraper — ARMEPS

> Step-by-step build order for the ARMEPS ingestion path.
>
> **Status: built and verified end-to-end on 2026-08-03.** This document is kept as the
> rationale record — why each file exists and what the source does to you. Three claims in the
> original version turned out to be wrong once run against the live site; each is corrected
> inline below and marked **CORRECTION**.
>
> Companions: [SCRAPER_WORKFLOW.md](SCRAPER_WORKFLOW.md) (pipeline design) ·
> [ARCHITECTURE.md](ARCHITECTURE.md) (layering, folder structure).

---

## Verified facts about the source

Everything below was confirmed against the live site on 2026-08-02. Read this
section before writing a line — three of these facts change the design.

### Where the data actually is

| What | Where | Notes |
|---|---|---|
| Listing (open competition) | `https://gnumner.minfin.am/hy/page/bac_mrcuyti_haytararutyun_ev_hraver/` | server-rendered HTML, UTF-8, ~53 KB |
| Pagination | append `/2`, `/3` … to that path | page 1 has no suffix; 28 pages at time of writing |
| Notice detail | `https://armeps.am/epps/cft/viewContractNotices.do?resourceId={id}` | **different host** |
| Document list | `https://armeps.am/epps/cft/listContractDocuments.do?resourceId={id}` | this is the URL the listing links to |
| Buyer org | `https://armeps.am/epps/prepareViewCAOrganisation.do?id={n}` | linked from the detail page |

### The three facts that shape v1

**1. The detail pages are AJAX-rendered.** `viewContractNotices.do` returns
HTTP 200 with 34 KB of HTML, but the only server-rendered `<table>` on it is the
sidebar calendar. The notice body arrives through
`/epps/pageIterator/manage.cft.contract.document.supplier.do` and
`/epps/common/commonAjaxCall.do` after page load. Cheerio alone gets you nothing.

> **Consequence:** v1 scrapes the **listing only**. The listing already carries
> `sourceId`, title, `publishedAt` and `deadlineAt` — enough for discovery,
> saved-search matching, and deadline alerts, which is the whole hook.
> Buyer, CPV, value and documents are v2, and need either the AJAX endpoints
> (reverse-engineer the pageIterator POST) or the Playwright fallback.
> Do not let v1 block on this.

**2. `gnumner.minfin.am` serves an incomplete TLS chain.** It sends the leaf
(`CN=*.minfin.am`) but omits the `GoGetSSL RSA DV SSL CA 2` intermediate. Node
fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`; so does plain `curl`. Fix in
step 3 — and **not** with `rejectUnauthorized: false`.

**3. `robots.txt` does not exist, and the 404 page is HTML.**
`https://gnumner.minfin.am/robots.txt` returns an HTML "404 - Page Not Found"
document rather than a 404 status; `armeps.am` and `eauction.armeps.am` do the
same. There is therefore no robots check in the pipeline. If you add a source
that *does* publish crawl rules, reinstate one — and guard on `Content-Type:
text/plain`, because handing an HTML error page to a robots parser means parsing
a page template as crawl rules.

### Listing row markup (exact, from the live page)

```html
<div class="tender">
  <div class="tender_title">
    <p class="cont_text">
      <a href="https://armeps.am/epps/cft/listContractDocuments.do?resourceId=12347668">
        Արտաշատ քաղաքի Կիրովի 12 հասցեում վերելակների ...
      </a>
    </p>
  </div>
  <img class="doc_img" src="..." alt="" title="download" />
  <div>
    <p class="tender_time">
      (Հրապարակված է 2026-07-31 16:08:00-ից մինչեւ 2026-08-31 10:00:00 ժամը ներառյալ)
    </p>
  </div>
</div>
```

Pagination block:

```html
<div class="pagination bootom__line">
  <span class="selected_url">1</span>
  <a href=".../bac_mrcuyti_haytararutyun_ev_hraver/2" class="numbers_url">2</a>
  ...
  <a href=".../bac_mrcuyti_haytararutyun_ev_hraver/28" class="numbers_url">28</a>
</div>
```

**Rows are duplicated.** Page 1 renders 10 `div.tender` blocks but only
**6 unique `resourceId`s** — the same notice is emitted more than once. Dedupe by
`resourceId` *within* the page before doing anything else, and never treat
"10 rows" as "10 tenders". A row count is not a coverage metric here.

### Dates

Format is `YYYY-MM-DD HH:MM:SS`, two per row, in the sentence
*"Հրապարակված է {published}-ից մինչեւ {deadline} ժամը ներառյալ"*
("published from {published} until {deadline} inclusive").

Times are Armenia local — **UTC+04:00, no DST** (the ARMEPS header clock is
labelled `AMT`). `new Date('2026-07-31 16:08:00')` parses as *server* local time,
which is wrong on any host not set to Yerevan. Always append the offset.

---

## Build order

### Step 0 — unblock the repo

Three things will throw before any scraper runs:

1. `src/configs/knex.config.js` uses `require()` in an ESM package. Convert to
   `import config from './variables.config.js';` and drop `'use strict'`.
2. `db/migrations/create_table.js` and `drop_table.js` import
   `../../configs/knex.config.js`, which resolves *outside* the repo. Correct
   path is `../../src/configs/knex.config.js`.
3. `src/queue.js` hardcodes `localhost:6379`. Point it at
   `redis.connectionOptions` from `src/libs/redis.js`.

Then confirm the DB and Redis are reachable: `npm run migrate:up`, `redis-cli ping`.

### Step 1 — schema gap

`source_payloads` has only a primary key. The pipeline's whole idempotency story
is "have I seen `(source, ref)` at this `hash`?", and two workers can race on it.
Add a migration:

- `unique(['source', 'ref', 'hash'])` — makes a duplicate insert a DB error, not a duplicate row
- `index(['source', 'ref', 'fetched_at'])` — "latest payload for this ref"
- `index(['source', 'fetched_at'])` — the freshness monitor's query

While you are there, `tenders` wants `index(['is_latest', 'published_at'])`.

### Step 2 — config

Add to `sources.config.js` under `armeps`:

```js
listingPaths: [
  { slug: 'open-competition', path: '/hy/page/bac_mrcuyti_haytararutyun_ev_hraver/' },
],
detailBaseUrl: process.env.SOURCE_ARMEPS_DETAIL_BASE || 'https://armeps.am',
```

Adding a board later should be a config line, not a code change.

Add to `SCRAPER` in `variables.config.js`:

```js
EXTRA_CA_DIR: optional('SCRAPER_EXTRA_CA_DIR', './certs'),
```

### Step 3 — `src/libs/http.js` ⚠️ tricky

Responsibility: one axios client for all scraping. Bot UA, timeout, conditional
GET, byte-level charset decoding, retryability classification.

**The TLS part.** Fetch the missing intermediate once and commit it:

```bash
mkdir -p certs
curl -s http://crt.sectigo.com/GoGetSSLRSADVSSLCA2.crt \
  | openssl x509 -inform DER -out certs/gogetssl-rsa-dv-ca2.pem
```

Then extend the trust store instead of disabling it:

```js
import fs from 'fs';
import path from 'path';
import https from 'https';
import tls from 'tls';

// gnumner.minfin.am sends a valid leaf but omits the GoGetSSL intermediate, so
// Node cannot build a chain to a root. Supplying the missing intermediate keeps
// verification ON — `rejectUnauthorized: false` would make us accept *any*
// certificate for these hosts.
const loadExtraCAs = () => {
  const dir = path.resolve(config.SCRAPER.EXTRA_CA_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(pem|crt|cer)$/i.test(f))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
};

const extraCAs = loadExtraCAs();
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 8,
  ca: extraCAs.length ? [...tls.rootCertificates, ...extraCAs] : undefined,
});
```

**The charset part.** Fetch as `responseType: 'arraybuffer'` and decode from the
declared charset with `iconv-lite`. gnumner declares UTF-8 today, but the PPCM
exports you add next do not, and by then this code is shared.

```js
const decode = (buffer, contentType) => {
  const m = /charset=["']?([\w-]+)/i.exec(contentType || '');
  const charset = (m ? m[1] : 'utf-8').toLowerCase();
  if (charset === 'utf-8' || charset === 'utf8') return buffer.toString('utf8');
  return iconv.encodingExists(charset) ? iconv.decode(buffer, charset) : buffer.toString('utf8');
};
```

Two more details that matter: set `validateStatus` to accept **304** (a
conditional-GET hit is success, not an error), and export an `isRetryable(error)`
that returns true only for 5xx, 429, and `ECONNRESET`/`ETIMEDOUT`/`EAI_AGAIN`
— everything else should reach the DLQ immediately rather than burn five attempts.

> **CORRECTION.** Elsewhere this guide treats conditional GET as what makes a 5-minute cron
> cheap. It is not, for this source: gnumner returns **no `ETag`, no `Last-Modified`, no
> `Cache-Control`**, so 304 never arrives and every visited page is re-downloaded. Keep the
> code (it costs nothing, and PPCM may honour it), but sweep economy comes entirely from the
> early-stop rule in step 10. Also worth knowing: the host is slow — ~3.5s typical, and one
> request exceeded the 30s timeout during testing, so retries matter more than usual.

Signatures:

```js
fetchPage(url, { etag, lastModified })
  -> { status, notModified, body, raw, contentType, etag, lastModified }
isRetryable(error) -> boolean
```

### Step 4 — `src/libs/rateLimiter.js`

Responsibility: per-source politeness, plus a sweep lock.

Keep the counter in **Redis, not in-process** — the budget belongs to the source,
so three worker replicas must share one. A fixed window keyed
`ratelimit:{source}:{floor(now/perMs)}` is sufficient; `INCR` + `PEXPIRE` on first
hit.

```js
acquire(source, { requests, perMs }) -> msToWait   // 0 = go ahead
withLock(name, ttlMs, fn) -> { skipped, result }
```

`acquire` returns a **delay**, and the caller must delay the job rather than fail
it — being throttled is not an error and must not consume a retry attempt.

`withLock` matters more than it looks: the armeps cron is `*/5 * * * *` and a
full 28-page sweep can exceed five minutes. Without the lock, sweeps stack up and
you self-inflict a rate-limit spiral. Release only if the token is still yours.

### Step 5 — `src/libs/hash.js`

`sha256(input)` plus a `stableHash(obj)` that sorts keys before serialising.

`stableHash` is the amendment-detection primitive: hash the *meaningful* row
fields (`sourceId`, `title`, `publishedAt`, `deadlineAt`, `url`), not the page.
Page markup churns on every request — ad blocks, view counters, the sidebar
calendar — so a page hash would report every fetch as a change. Row hashes are
what gate downstream work.

### Step 6 — `src/libs/adapters/source/armeps/listing.parser.js` ⚠️ tricky

Responsibility: HTML string → `{ rows, pagination }`. **Pure function, no I/O,
no DB, no network.** This is the file that breaks when the site is redesigned,
and keeping it pure is what makes that a one-file fix with a unit test.

```js
import * as cheerio from 'cheerio';

// Armenia is UTC+4 year-round (no DST). `new Date('2026-07-31 16:08:00')` would
// parse in the *server's* zone, silently shifting every deadline on any host not
// set to Yerevan.
const AM_OFFSET = '+04:00';
const toDate = (s) => new Date(`${s.replace(' ', 'T')}${AM_OFFSET}`);

// "(Հրապարակված է 2026-07-31 16:08:00-ից մինչեւ 2026-08-31 10:00:00 ժամը ներառյալ)"
// Matched positionally on the two timestamps rather than on the Armenian words,
// so a wording tweak on the site does not break date extraction.
const TIMESTAMP = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/g;

const parseWindow = (text) => {
  const found = String(text).match(TIMESTAMP) || [];
  return {
    publishedAt: found[0] ? toDate(found[0]) : null,
    deadlineAt: found[1] ? toDate(found[1]) : null,
  };
};

export const parseListing = (html, { pageUrl }) => {
  const $ = cheerio.load(html);
  const seen = new Set();
  const rows = [];

  $('div.tender').each((_, el) => {
    const $el = $(el);
    const link = $el.find('.tender_title .cont_text a').first();
    const url = link.attr('href');
    if (!url) return;

    // sourceId is ARMEPS's own resourceId — the natural dedupe key, and stable
    // across the 2027 OCDS migration in a way a URL is not.
    const sourceId = new URL(url).searchParams.get('resourceId');
    if (!sourceId) return;

    // The board renders each notice more than once (page 1: 10 blocks, 6 unique
    // ids). Without this the same tender is hashed and enqueued repeatedly.
    if (seen.has(sourceId)) return;
    seen.add(sourceId);

    rows.push({
      sourceId,
      url,
      title: link.text().trim().replace(/\s+/g, ' '),
      ...parseWindow($el.find('.tender_time').text()),
    });
  });

  // Highest numbered page link; page 1 carries no suffix.
  const lastPage = Math.max(
    1,
    ...$('div.pagination a.numbers_url')
      .map((_, a) => parseInt($(a).text().trim(), 10))
      .get()
      .filter(Number.isFinite)
  );

  return { rows, pagination: { lastPage, pageUrl } };
};
```

**Write the unit test in the same step**, against a saved fixture of the page —
not against the network. Assert: 6 unique rows from page 1's 10 blocks, first
`sourceId === '12347668'`, `publishedAt.toISOString()` ends in `12:08:00.000Z`
(16:08 AMT), and `lastPage === 28`. That last assertion is your redesign alarm.

### Step 7 — `src/libs/adapters/source/armeps/client.js`

Responsibility: URL construction and the politeness gate, so the worker never
builds a URL or thinks about the request budget.

```js
listingUrl(pathConfig, page)  // page 1 => no suffix; page N => `${path}${N}`
fetchListing(pathConfig, page, { etag, lastModified })
```

Order inside `fetchListing`: `rateLimiter.acquire` (throw a typed
`RateLimitedError` carrying `retryAfterMs` if non-zero) → `http.fetchPage`.

### Step 8 — `src/repositories/sourcePayload.repository.js`

The only file touching the `source_payloads` table.

```js
findByRef(source, ref)                     // latest row
existsWithHash(source, ref, hash)          // the idempotency check
record({ source, ref, storageKey, hash })  // insert, ignore unique violation
latestFetchedAt(source)                    // last CHANGE — see correction below
```

> **CORRECTION.** Step 1 lists `index(['source','fetched_at'])` as "the freshness monitor's
> query", and this file exposes `latestFetchedAt` for it. Both mislead: unchanged content is
> deliberately never inserted, so `max(fetched_at)` is the last *change*, not the last
> successful *fetch* — a healthy source that published nothing for an hour would look dead and
> page someone at 3am. Sweep health is a Redis key `sweep:ok:{source}` written by the worker on
> every successful page. Keep `latestFetchedAt` for "when did this source last publish
> something new", but never wire the alert to it.

`record` should swallow the unique-violation error (Postgres `23505`) — under a
race the row already existing *is* the success condition.

### Step 9 — `src/queues/index.js` + `names.js`

`names.js` exports `QUEUE` and `JOB` constants. Producers and consumers live in
different processes, so a string typo is a job that silently never runs.

v1 needs `ingest.fetch` and `ingest.normalize`. Default job options:
`attempts: SCRAPER.MAX_ATTEMPTS`, `backoff: { type: 'exponential', delay:
BACKOFF_BASE_MS }`, `removeOnComplete: { age: 86400 }`, `removeOnFail: false`
(keep failures — they are the DLQ).

### Step 10 — `src/workers/scraper.js` ⚠️ the centrepiece

Two handlers on `ingest.fetch`.

**`source.sweep`** — wrap the whole thing in `withLock('sweep:armeps', ...)`, then
for each entry in `listingPaths` enqueue a `listing.page` job for page 1 with
`since = now - lookbackHours`.

**`listing.page`** — the chained-pagination pattern:

1. `client.fetchListing(pathConfig, page, conditionalHeaders)`.
2. `304` → done, do not enqueue the next page.
3. `parseListing(...)`. **If `blocksSeen === 0` on a 200, throw** — a silent
   empty result is the failure mode that costs customers tenders. It must page
   someone, not log at info.

   > **CORRECTION.** This originally said to throw when `rows.length === 0`. That conflates
   > two different conditions and misfires. The board mixes ARMEPS notices (with a
   > `resourceId`) and direct-attachment notices (a ZIP on gnumner — Gazprom Armenia
   > open-offer requests, ministry quotation requests). From roughly page 14 on, pages hold
   > *only* the second kind, so `rows.length === 0` there is normal, not a broken parser. The
   > parser must return `blocksSeen` and a `skipped` count alongside `rows`; the alarm fires on
   > `blocksSeen === 0`, and skipped counts get logged so coverage loss stays visible.

4. Store the page body once at `rawKey({ source, ref: 'listing:{slug}:p{n}', hash, ext: 'html' })`.
5. Per row: `stableHash(row)` → `existsWithHash` → skip if known; otherwise
   `record(...)` with `ref: 'notice:{sourceId}'` and enqueue `normalize.tender`
   carrying the row plus the raw storage key.
6. Enqueue page N+1 **only while the page still holds notices newer than `since`**, and
   `page < min(lastPage, maxListingPages)`.

   > **CORRECTION.** This originally also continued whenever a page had new rows
   > (`changed > 0 || withinWindow`). That makes `lookbackHours` meaningless: the board is a
   > **9-year archive reaching back to 2017**, and on a cold start the rule walked it page after
   > page, bounded only by `maxListingPages`. The window must be the depth control. Measured
   > publication rate is ~1.2 notices/hour typical and ~7.5/hour at peak against ~10 notices per
   > page, so a routine sweep needs 1–2 pages; post-outage depth comes from the window widening
   > the gap, automatically. Full-history loading is a deliberate backfill with its own range.

Points 3 and 6 are the two that actually matter. Everything else is plumbing.

### Step 11 — `src/workers/index.js`

Worker process entry: build the BullMQ `Worker` instances with
`redis.connectionOptions` and `concurrency` from the source config, register
`SIGTERM`/`SIGINT` handlers that `await worker.close()` (in-flight jobs finish and
are not lost), and log every `failed` event with the job name and attempt count.

### Step 12 — prove it

Before wiring the cron, run the sweep once by hand:

```bash
node --input-type=module -e "
  import('./src/libs/adapters/source/armeps/client.js').then(async (c) => { /* fetch page 1 */ });
"
```

Then assert, in order:

1. Objects appear under `raw/armeps/` in `.storage/` (set `STORAGE_DRIVER=local`
   for this — no MinIO needed).
2. `select count(*) from source_payloads where source='armeps'` — the count should
   be **unique notices**, not row blocks. On page 1 that is 6, not 10. If you see
   10, your in-page dedupe is not working.
3. Re-run the sweep immediately. The count must **not** change and no
   `normalize.tender` jobs should be enqueued. That is the idempotency proof, and
   it is the single most important test in the pipeline.
4. `redis-cli llen bull:ingest.normalize:wait`.

Only after 3 passes should you register the repeatable job in
`src/queues/scheduler.js`.

---

## Deliberately out of scope for v1

Note these so they do not creep in:

- **Detail-page enrichment** (buyer, CPV, estimated value) — needs the AJAX
  endpoints or Playwright. Fact #1.
- **Document download** — `prepareAnonymousDownload.do` requires a form round-trip
  and a `jsessionid` cookie jar. Keep `downloadDocuments: true` in config but do
  not act on it yet.
- **The normalizer** — v1 stops at enqueueing `normalize.tender`. Writing
  `tenders`/`parties` rows is the next build unit.
- **Other notice boards** — one board proves the pipeline; the rest are config
  entries once it works.

## When it breaks

It will, and the failure will be silent unless you build for it. The listing
parser is one file with one fixture test; a redesign means updating both and
replaying `normalize.tender` from the retained `raw/` payloads — no re-crawl.
Alert on zero rows and on `max(fetched_at)` lagging past
`SCRAPER.FRESHNESS_SLA_MINUTES` (15). A scraper that returns nothing while
reporting success is worse than one that crashes.
