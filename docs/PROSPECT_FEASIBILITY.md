# Prospect List Feasibility Audit & Build Plan

> Assessed 2026-08-15 against the live TenderIQ codebase (not the possibly-stale
> "Current state" sections of CLAUDE.md / PROJECT_STATUS.md — verified file-by-file)
> and one live probe of the ARMEPS public site. Companion code:
> `src/repositories/prospects.repo.js`, `src/services/prospectScoring.service.js`,
> `src/scripts/exportProspects.js`, `db/migrations/002_create_public_tender_bids.js`.

## TL;DR

Your stated expectation — *"the ARMEPS adapter only yields the government buyer,
and supplier/award data requires the ppcm (gnumner.minfin.am) source, which is
currently disabled"* — is **half right, and the wrong half changes the plan.**

- **Right:** nothing usable for prospecting exists in the database today, and the
  currently-wired ingestion path doesn't even resolve real buyers, let alone
  suppliers.
- **Wrong:** enabling `ppcm` is not the blocking task. A live probe of a completed
  ARMEPS tender (`tender_details/tid/40000/`) shows the **ARMEPS detail page
  itself** — a source that's already enabled — renders a full per-lot bids table
  (`Գնառաջարկներ`) once a tender's status reaches "Ավարտված" (completed): every
  bidding company's name, their initial and final offer price, VAT, rank, and
  accept/reject status. That is the entire feedstock the ICP model needs — bid
  frequency, value, win/loss, near-misses — and it requires no `ppcm` dependency
  at all.

So the blocking task is **"parse the ARMEPS completed-tender bids table,"** not
"stand up a new source adapter." That's a parser + a small schema addition, not a
new integration. `ppcm` still has a place (see "Where ppcm still fits" below), but
it is not on the critical path to a first prospect list.

No prospect list is included in this deliverable. Per your constraint, a list
built from proxies (bid *counts* invented from listing-page volume, vertical
guessed from company name, etc.) is worse than no list. Every one of the four
Step 3 deliverables you asked for is either produced empty-but-real (the DB
genuinely holds zero qualifying rows right now) or delivered as working code +
exact query, ready to run the moment the parser lands.

---

## Step 1 — Feasibility audit

### What I could and couldn't verify directly

I have full read access to the repo and to the CRM reference docs via the device
bridge. I do **not** have network access from this session to your Neon Postgres
instance or to your local MinIO (`localhost:9000`) — both are outside this
sandbox's egress allowlist, and the local device shell bridge (`device_bash`)
reported "workspace unavailable" for the whole session, so I couldn't run a query
on your machine either. Everything below is therefore **derived from reading the
actual source code, not from live row counts.** For this particular audit that's
sufficient to reach a confident conclusion — see why under each item — but if you
want the literal current counts, run this once and paste me the output:

```sql
select count(*) from source_payloads;
select count(*) from tenders;
select count(*) from parties;
select role, count(*) from parties group by role;
select count(*) from awards;
```

I also fetched two live ARMEPS pages (`tender_details/tid/46753/` — an open
future tender, and `tid/40000/` — a completed one) through the standard WebFetch
tool, specifically to check whether a bids/results table exists on completed
tenders. That's a single manual page view for research, not new crawling
infrastructure, and it didn't touch the ingestion pipeline, its rate limiter, or
its storage.

### (a) In the DB now

**Effectively nothing usable for prospecting, and the buyer isn't even real.**

The wired production path is `scraper.js` (`handleListingPage`) →
`normalizer.js` (`normalizeTender`) — that's the only queue consumer actually
registered in `workers/index.js`. Trace what it writes:

- `workers/normalizer.js`'s `mapArmepsListing()` maps every single tender to a
  **hardcoded placeholder buyer**:
  ```js
  const LISTING_BUYER = { id: 'armeps:listing-buyer', name: 'Unknown buyer (ARMEPS listing)', role: 'buyer' };
  ```
  Every tender's `buyer_id` points at this one fake party row. `cpv_code` and
  `estimated_value` are hardcoded `null`. This is because the listing page
  (which is all this path reads) genuinely doesn't carry buyer/CPV/value — but
  the practical effect is that **`parties` never grows past one placeholder row**
  via this path, regardless of how much you sweep.
- `src/repositories/parties.repo.js` has a *correctly written* `upsertParty` /
  `upsertTender` pair that does resolve the real buyer name from a detail page —
  but nothing in the wired worker graph calls it. It's dead code today.
- `src/workers/importer.js` (`fetchDetail`) does fetch and store real detail
  pages (which do have the real buyer name, via `detail.parser.js`) — but it has
  **no queue consumer**. `queues/names.js` defines only `INGEST_FETCH` and
  `INGEST_NORMALIZE`; `workers/index.js` only ever instantiates workers for
  those two. `importer.js` is unreachable from any schedule or sweep.
- `awards`, `contracts`: zero writers anywhere in the codebase. No code path
  inserts into either table.
- `tax_id` on `parties`: no parser anywhere ever populates it (see part (c)).

Net: whatever `tenders` row count you get back from the query above, `parties`
realistically has at most 1 meaningful row (the placeholder) plus whatever
`upsertParty` calls happened outside the live pipeline (none, as far as the code
shows). **Zero suppliers, zero awards, zero tax IDs — guaranteed by code
inspection, independent of the exact row counts.**

### (b) Present in a raw payload, but unparsed — this is the real finding

Two different "unparsed" situations exist, and they matter differently:

1. **Real buyer name, description, goods/works/services type, attachments** —
   already extracted by `detail.parser.js`, just never reaches the DB because
   nothing calls `importer.js`/`fetchDetail` from the live sweep. This is a
   wiring gap, not a parsing gap: cheap to fix (see plan below).

2. **The bids table — the actual blocker, now resolved.** `detail.parser.js`
   only ever looks for 8 labeled fields (`Վերնագիր`, `Գնորդ`, `Ծածկագիր`,
   `Կարգավիճակ`, `Գնման տեսակ`, and three date fields). It does not look for,
   and the live probe confirms the page *does* contain once a tender closes, a
   **`Գնառաջարկներ` (bids/offers) table**, one row per company per lot:

   | Column (Armenian) | Meaning |
   |---|---|
   | Չափաբաժնի համար | Lot number |
   | Զբաղեցրած տեղ | Rank (1 = won the lot) |
   | Ներկայացված հայտեր | Submitted applications |
   | Նախահաշվային գին | Budget price |
   | Նախնական առաջարկ (Արժեք / ԱԱՀ / Գին) | Initial offer (value / VAT% / price) |
   | Վերջին առաջարկ (Արժեք / ԱԱՀ / Գին) | Final offer (value / VAT% / price) |
   | Մասնակցի կարգավիճակ | Participant status — blank = accepted, "Մերժված" = rejected |

   Bidder names are hyperlinks (`.../procurer/bo_details/tid/<tenderId>/id/<supplierId>/`
   pattern) carrying a stable per-tender supplier reference — useful for name
   dedup even before any tax ID exists. On the one completed tender checked
   (`tid/40000`, 30 lots), roughly 13 distinct companies bid, with prices,
   ranks, and accept/reject status all present.

   **This table is exactly bid frequency + value + win/loss in one place**, and
   it lives on a source that's already `enabled: true` in `sources.config.js`.
   No `ppcm` dependency, no new adapter directory, no new politeness gate to
   design — just a new labeled section for `detail.parser.js` to extract, plus
   wiring the detail-fetch path into the live sweep, plus a trigger to refetch a
   tender once its status flips to "Ավարտված" (today nothing refetches a tender
   after its first ingest — `normalizeTender`'s amendment-hash check would
   in fact treat the eventual "Ավարտված" status change as a normal amendment
   IF the detail page were being fetched on a schedule, which it currently
   isn't).

### (c) Not collected at all

- **`ppcm` / gnumner.minfin.am**: `sources.config.js` has `ppcm: { enabled:
  false, ... }`, and `src/libs/adapters/source/ppcm/` **is a completely empty
  directory** — zero files, not "disabled code." This part of your original
  expectation is correct: this adapter does not exist yet in any form.
- **Tax ID (ՀՎՀՀ)**: not present on either the open or the completed tender
  page I checked. The bidder-name hyperlink leads to a company profile page
  (`/hy/procurer/bo_details/...`) that redirects to an ARMEPS **login page**
  when fetched anonymously — tax ID, if ARMEPS exposes it at all, sits behind
  authentication. Per your constraint ("public procurement data only," no
  bypassing access controls), that page is out of scope. Tax ID may still be
  obtainable from a `ppcm` CSV export if the Ministry of Finance includes it
  there (plausible for an official finance-ministry export, but I have no
  sample file to confirm — flagging as unverified, not assumed).
- **CPV codes**: never parsed by either parser; the schema column exists and is
  always written `null`. `Գնման տեսակ` (goods/works/services) is a real field
  but is a 3-way classification (Goods / Works / Services), far too coarse for
  vertical inference on its own.
- **Participant counts as a distinct concept**: subsumed by the bids table once
  parsed (count the rows), so this isn't really a separate gap.

### Where `ppcm` still fits

Per `ARMEPS vs TenderIQ.md`, `gnumner.minfin.am` (PPCM) is the plans-and-contracts
bulletin — "View awards & contracts (PPCM) — Downloadable as CSV/Excel." Once the
ARMEPS bids table is flowing, `ppcm` becomes a **secondary, corroborating**
source: official signed-contract values (post-award, sometimes different from
the auction's final offer if a contract is renegotiated), and possibly tax IDs.
It's real future work, just not the blocking task.

---

## Corrected blocking-task plan, cheapest first

1. **Extend `detail.parser.js` to parse the `Գնառաջարկներ` bids table**, and
   introduce a new table to store it — `public_tender_bids`
   (`db/migrations/002_create_public_tender_bids.js`, included in this
   delivery, not yet applied to your database — see that file's header for
   why it's a standalone script rather than a change to `create_table.js`).
   I did **not** write the parser code itself: WebFetch gives me
   AI-summarized markdown, not raw DOM, and this codebase's own convention
   (see the comment on `findByLabel` in `detail.parser.js`) is to not trust a
   selector until it's checked against real fetched HTML. The next session
   with either `device_bash` working or a manual raw-HTML paste can write and
   verify this against `tid/40000/` as the fixture, the same way
   `tid/46753/` became the fixture for the existing fields.
2. **Wire detail-fetching into the live sweep.** Either give `importer.js` a
   real queue consumer, or fold its logic into `scraper.js`'s per-row loop.
   Either way, `normalize.tender` needs to run against the *detail* page (real
   buyer, real dates) instead of only the listing page.
3. **Add a re-check trigger for tenders past their `auction_at` date** whose
   last known status wasn't "Ավարտված" yet — that's what lets the bids table
   ever get scraped; today nothing revisits a tender after first ingest.
4. **(Secondary, not blocking)** Build the `ppcm` adapter for corroborating
   award/contract data, once there's a sample CSV/Excel export to design the
   parser against.

---

## Step 2 — ICP scoring model (implemented, not yet runnable)

Implemented in `src/services/prospectScoring.service.js`, pure business logic,
no DB access (per the hard boundary — SQL stays in `src/repositories/`). Every
threshold in the file is commented with the doc line it comes from; summary:

| Input | Weight | Source in docs | How it's computed |
|---|---|---|---|
| Bid frequency | 0.35 | Target Customers.md: "bids at least monthly" is the core qualifier | `bid_count / months_active`, saturating at 2/mo |
| Value density | 0.25 | "one win must dwarf the subscription" | median win (AMD→USD) vs. 5× the $1,200/yr Pro reference from Pricing Strategy.md |
| Vertical | 0.20 | construction/IT/medical = P0, pharma/equipment/consultants = P1, food = P2, else P3 | keyword match over the supplier's own bid *titles*, never their company name |
| Recency | 0.10 | "active in the last 90 days" | 1.0 within 90 days, linear decay to 180 days out |
| Loss signal | 0.10 | "a frequent loser is the hottest prospect" | loss_count / (win_count + loss_count) — high is *good* here |

Below `MIN_BIDS_FOR_SCORE = 3` bids or `MIN_MONTHS_FOR_SCORE = 2` months of
history, a candidate returns `insufficientData: true` with a reason string
instead of a fabricated score.

**Vertical inference** (`inferVertical`, `getTopCategories`) runs on
Armenian/Russian keyword lists against tender titles and goods/works/services
labels — company name is never in the input. `topCategories` (up to 3) is a
by-product of the same keyword tally, distinct from the single collapsed
`vertical` used for scoring.

**Pricing tier mapping** (`suggestPricingTier`, per Pricing Strategy.md):

| Tier | Rule used | Caveat |
|---|---|---|
| Starter | < 1 bid/month | — |
| Pro | ≥ 1 bid/month | — |
| Team | ≥ 1 bid/month AND high value density AND ≥ 8 distinct tenders | Proxy only — Pricing Strategy.md ties Team to seats/multi-user, which bid data cannot observe |
| Consultant | **not assignable from this data at all** | A consultancy bids under each *client's* name, so it never appears as its own `parties.role='supplier'` row. Identifying consultants is a separate research task (e.g. cross-referencing repeat filer patterns across unrelated clients), not a scoring output. |

---

## Step 3 — Deliverables

### (a) Repository method

`src/repositories/prospects.repo.js` — three functions, SQL only:

- `listProspectCandidates(db, { sinceMonths, minBids, orderBy })` — one row per
  supplier, aggregated from `public_tender_bids` (bid/tender/win/loss counts,
  total/median/min/max final price, first/last bid date, sampled tender
  titles for vertical inference downstream).
- `getProspectBidHistory(db, supplierId, { sinceMonths })` — full per-lot bid
  history for one supplier.
- `getProofSheetData(db, supplierId, { sinceMonths })` — see (c) below.

All three join against `public_tender_bids`, which does not exist in your
database yet. **Run against the live DB today, they return `[]` — correctly**,
because the join target is empty/nonexistent, not because the SQL is wrong.

### (b) Ranked prospect export

`src/scripts/exportProspects.js` — `node src/scripts/exportProspects.js`
(optionally `AMD_TO_USD=<rate>` for value-density scoring). Writes
`prospects_export.csv` / `.json` with exactly the columns you asked for:
company name, tax ID (if known), bid count, total/median contract value, top 3
categories, inferred vertical, win/loss counts, last bid date, ICP score,
suggested tier — plus `insufficient_data` / `reason` columns so a short list is
visibly short, never padded.

I have not run this script: it needs the live DB, which this session cannot
reach, and until the migration + parser above land, the honest output is
literally zero rows anyway. Run it yourself once step 1–3 of the plan above are
done; it will do the right thing at every stage in between (empty file →
`insufficient_data` warning; some real rows → real rows; below-threshold
candidates → flagged, not silently dropped or silently scored).

### (c) Proof sheet — spec + exact query

The sales artifact from Sales Strategy.md: *"their missed tenders + a rival's
winning prices."* `getProofSheetData(db, supplierId)` in `prospects.repo.js`
does exactly this: every lot the supplier bid on and did not win (rank ≠ 1 or
status = rejected), self-joined to the rank-1 row on the *same* tender+lot for
the rival's name and final price, with a computed `pct_above_winner`.

Rendering spec for the printed/PDF sheet (not yet built — this is the query it
runs on):

- Header: supplier name, generated date, lookback window.
- One row per lost lot: tender title + reference code, buyer name, lot #, our
  final price, rival's final price, % above winner, tender date.
- A lot where the rival's `supplier_id` failed to resolve (name didn't match
  an existing party) must render as **"result unknown"**, never as a guessed
  or blank-defaulted rival — the query already returns `null` for those
  columns rather than silently dropping the row; the renderer must preserve
  that distinction. Fabricating a rival name here would be exactly the kind
  of invented number the brief rules out.

### (d) Segment summary

Real numbers, honestly zero:

| Vertical | Prospects | P0 firms w/ Pro-tier activity |
|---|---|---|
| Construction | 0 | insufficient_data |
| IT | 0 | insufficient_data |
| Medical/equipment | 0 | insufficient_data |
| Pharma/consultants | 0 | insufficient_data |
| Food | 0 | insufficient_data |
| Other/small | 0 | insufficient_data |

Every cell is 0 because `public_tender_bids` has 0 rows in the current schema
(it doesn't exist yet) — not because suppliers don't exist in ARMEPS's public
data. Once the plan above lands and a sweep of recently-completed tenders runs,
re-run `exportProspects.js` and this table repopulates with real counts you can
use to pick a launch vertical, exactly as asked. I'm not estimating counts in
the meantime — Target Customers.md's own worked example ("40 most active IT
bidders...") is a scenario, not a measurement, and presenting it as a number
would be exactly the fabrication the brief prohibits.

---

## Constraint compliance notes

- **No fabricated numbers.** Every "0" above is a real property of the current
  schema/data, not a placeholder. `insufficient_data` is threaded through the
  scorer, the export, and the segment table rather than being handled at only
  one layer.
- **Public procurement data only.** The one live probe (WebFetch, 2 URLs) hit
  only public tender-detail pages; the one attempt to reach a company profile
  page hit ARMEPS's own login wall and was not pursued further — no
  credentials, no bypass attempted.
- **No new HTTP clients / no bypassing.** No parser code was added speculatively
  (see the "did not write" note under the blocking-task plan). The one live
  fetch used the sanctioned WebFetch tool for a single manual page view, not a
  new crawler, and did not touch `source_payloads`, storage, or the rate
  limiter.
- **Idempotency respected.** Nothing here re-ingests anything; the plan
  explicitly re-uses the existing raw-payload-retention model (re-fetch/replay,
  never re-crawl what's already stored) and the new table's unique index
  (`tender_id, lot_number, supplier_id`) is designed to make its own future
  normalizer step idempotent the same way `tenders.source_id` already is.
- **`role = 'buyer'` is never a prospect.** Every query in `prospects.repo.js`
  filters `role IN ('supplier', 'both')` explicitly, with a comment pointing
  back at this rule so a future edit doesn't drift.

## File manifest

| File | Status |
|---|---|
| `docs/PROSPECT_FEASIBILITY.md` | new — this document |
| `db/migrations/002_create_public_tender_bids.js` | new — not yet applied to the live DB |
| `db/migrations/002_drop_public_tender_bids.js` | new — companion drop script |
| `src/repositories/prospects.repo.js` | new |
| `src/services/prospectScoring.service.js` | new |
| `src/scripts/exportProspects.js` | new |
