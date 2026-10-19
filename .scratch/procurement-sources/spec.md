Status: ready-for-agent

# Three submission channels: e-auction, ARMEPS and paper

Decisions recorded in [ADR 0004](../../docs/adr/0004-tender-identity-across-sources.md) and in the
*Tenders and sources* section of [CONTEXT.md](../../CONTEXT.md). Every fact this spec rests on
(volumes, endpoints, request shapes, the PPCM-vs-ledger check) is in [research.md](research.md).
Read both before starting any ticket.

## Problem Statement

A supplier opens Tendra and sees only e-auctions. They are about a quarter of Armenian public
procedures but **12% of contract value**. Open tenders alone are 62% of the money, and none of them
is here. The supplier's alternative, HayTender, shows all three submission channels, so a prospect
comparing the two sees a quarter of the market on Tendra's first screen. Missed tenders are this
product's #1 churn cause, and today most tenders are missed by design.

The loss is worse than it looks. Tendra's moat is competitors' prices, and it covers only the
auction, the one channel where a supplier can still react to rivals live. In a sealed ARMEPS bid
or a paper bid a supplier gets exactly one price and no second chance. That is where knowing what
rivals bid before matters most, and it is exactly where Tendra knows nothing.

Paper quotations add a timing problem. About six a day appear, mostly from schools, polyclinics
and regional bodies, and each one gives suppliers **seven days** to deliver a sealed envelope to
the buyer's office. A supplier who hears about it on day four has lost half the window.

## Solution

Tendra shows every tender from all three submission channels in one list, each labelled with its
channel and filterable by it.

- **e-auction**: unchanged.
- **ARMEPS**: sealed electronic open tenders and quotations. Discovered through gnumner, detailed
  from armeps.am (deadline, CPV, evaluation method, documents), and resolved through PPCM, which
  supplies every bidder's price and ՀՎՀՀ once the buyer files the result.
- **Paper**: discovered through gnumner's uploaded invitation files, with the deadline read from
  the file and deadline changes followed. Resolved through gnumner's contract-concluded `.docx`,
  which carries each bidder's net price, VAT and total per lot.

A tender is assembled from whichever sources describe it and never appears twice: the gnumner
notice and the armeps.am page for the same tender are one tender with two source links. Every
price that cannot be attached to exactly one tender is kept and counted with its reason, never
guessed onto a tender.

Intelligence (competitor prices, benchmarks, win rates, the price recommendation) then covers
sealed bids too, with no change to how it computes.

## User Stories

### Discovery

1. As a supplier, I want to see ARMEPS open tenders and quotations in the same list as
   e-auctions, so that I stop missing the largest contracts in my field.
2. As a supplier, I want to see paper quotations in the same list, so that I find small regional
   buyers my competitors overlook.
3. As a supplier, I want each tender labelled with its submission channel, so that I know at a
   glance whether I bid live online, upload one sealed bid, or deliver an envelope.
4. As a supplier, I want to filter the list by submission channel, so that I can see, for
   example, only the tenders I can bid on without travelling.
5. As a supplier who bids on paper, I want a paper tender's deadline shown as a date and time, so
   that I don't have to open a Word file and count days myself.
6. As a supplier, I want a paper tender whose deadline moved to show the new deadline, so that I
   neither miss it nor rush for nothing.
7. As a supplier, I want an alert when a paper tender's deadline changes, so that a change I
   haven't seen can't cost me the bid.
8. As a supplier, I want an ARMEPS tender to show its CPV code, so that my saved searches and the
   relevance ranking treat it like any other tender.
9. As a supplier, I want to see an ARMEPS tender's evaluation method (lowest price or criteria),
   so that I know whether price alone decides it.
10. As a supplier, I want an ARMEPS tender's documents (invitation in Armenian, English and
    Russian, bill of quantities) linked from the tender, so that I can prepare without searching
    another site.
11. As a supplier, I want a paper tender's invitation file linked from the tender, so that I can
    read its requirements and delivery address.
12. As a supplier, I want a link to each tender's original page on every source it came from, so
    that I can check the official record.
13. As a supplier, I want a paper tender listed even when its procedure code couldn't be read, so
    that an unreadable code never hides a real opportunity.
14. As a supplier, I want ARMEPS and paper tenders to trigger my saved-search alerts exactly as
    e-auctions do, so that I hear about them within minutes.
15. As a supplier, I want ARMEPS and paper tenders ranked in my relevant list, so that the
    ranking reflects the whole market.
16. As a supplier, I want to track an ARMEPS or paper tender in my pipeline, so that my bid
    workflow covers every tender I pursue.
17. As a supplier, I want a cancelled-and-re-announced procedure to appear as two tenders, so
    that the new run's deadline is never confused with the dead one's.

### Intelligence

18. As a supplier, I want to see every bidder's price on a finished ARMEPS tender, so that I
    learn what my competitors bid in sealed rounds.
19. As a supplier, I want to see every bidder's price on a finished paper tender, so that I learn
    the going rate at small regional buyers.
20. As a supplier, I want ARMEPS and paper prices compared on net value, like e-auction prices,
    so that a VAT-paying winner is never shown above a rival it beat.
21. As a supplier, I want price benchmarks to include sealed-bid results, so that a benchmark
    reflects the whole market rather than auctions only.
22. As a supplier, I want a benchmark to keep saying `insufficient_data` when sealed-bid results
    are too few, so that more sources never turn into a fabricated number.
23. As a supplier, I want my bid on an ARMEPS or paper tender reconciled into won / lost /
    not_found, so that my win rate counts every channel.
24. As a supplier, I want a sealed-bid tender that PPCM has not yet reported to stay unresolved
    rather than show as lost, so that a late filing is never a fabricated defeat.
25. As a supplier, I want competitors identified across channels, so that a rival I meet at
    auction is recognised when I meet them in a sealed bid.

### Operating Tendra

26. As the operator, I want every result that cannot be attached to one tender kept with its
    reason (`no_candidate`, `ambiguous`, `no_code`, `unsupported_format`), so that nothing is
    lost silently.
27. As the operator, I want those reasons counted per source per day, so that I can tell a
    broken parser from normal noise.
28. As the operator, I want a result that arrives before its tender to attach automatically once
    the tender is found, so that ordering between sources never loses data.
29. As the operator, I want a PPCM result for an ARMEPS tender Tendra never discovered to fetch
    that tender's armeps.am page and create it, so that a discovery gap repairs itself.
30. As the operator, I want unreadable file formats counted separately, so that I can decide from
    numbers whether a `.doc` or `.rar` converter is worth adding.
31. As the operator, I want a script that compares PPCM against the e-auction ledger and reports
    matched and unmatched counts by reason, so that I can verify the merge rules on real data
    without a test suite.
32. As the operator, I want gnumner's e-auction notices counted against the tenders Tendra holds,
    so that I have an independent check on e-auction coverage.
33. As the operator, I want the source key `armeps` renamed `eauction` before armeps.am arrives,
    so that one name never means two websites.
34. As the operator, I want each source to answer every repeat sweep with zero writes and zero
    jobs, so that the new sources keep the pipeline's idempotency.
35. As the operator, I want a source that returns zero items on a successful page to fail loudly,
    so that a redesigned gnumner or PPCM is caught before customers notice.
36. As the operator, I want every raw payload (HTML, JSON, `.docx`) kept in storage, so that a
    parser fix replays history instead of re-crawling it.
37. As the operator, I want the unmatched results stored in a shape an operator alert can read
    later, so that production alerting needs no data model change.

### Data

38. As the operator, I want PPCM to add the bidder's ՀՎՀՀ to existing e-auction parties when
    tender, lot and exact net price all match, so that a supplier becomes recognisable across
    sources without any name matching.
39. As the operator, I want e-auction bidder status and rank to keep coming only from the
    eauction ledger, so that PPCM's unreliable rejection flag never overrides it.
40. As the operator, I want a tender's status to only move forward (never from awarded or
    cancelled back to active), so that a stale page from one source can't reopen a finished
    tender.

## Implementation Decisions

### Terms

Use the *Tenders and sources* vocabulary throughout: **Tender** (one run), **Procedure code**,
**Submission channel** (never "channel" alone; that word is taken by alert delivery),
**Procedure type**, **Source**, **Unmatched result**, **Operator alert**.

### The rename comes first

- The source key `armeps` becomes `eauction` everywhere it is data: `tenders.source_id` prefixes,
  `source_payloads.source`, the `source` column defaults and values in `awards`,
  `public_tender_bids` and the ledger tables, the `parties.source_id` prefixes, Redis sweep and
  freshness keys, the sources config key and the adapter folder.
- Stored objects are not moved. `source_payloads` keeps pointing at the existing keys, so replay
  keeps working. New writes use the new prefix.
- It is done with an additive script, following the four-step schema workflow in CLAUDE.md.

### Schema

- **`tenders.submission_channel`**: `eauction | armeps | paper`, NOT NULL, constrained at the DB
  level like `procedure_type`. Existing rows backfill to `eauction`.
- **`tender_sources`**: one row per source link. `tender_id` (cascade), `source`, `external_id`,
  `url`, `role` (`discovery | detail | results`), `observed_status`, `first_seen_at`,
  `last_seen_at`. `UNIQUE (source, external_id)` is the dedupe anchor: re-seeing a link is an
  update, and a concurrent insert losing the race is success, as it is for `source_payloads`.
  Existing tenders get one `eauction` link each.
- `tenders.source_id` stays during this work as the creating link, and later readers move to
  `tender_sources`. Removing it is a follow-up, not part of this spec.
- **`unmatched_results`**: `source`, `external_ref`, `procedure_code` (nullable), `reason`
  (`no_candidate | ambiguous | no_code | unsupported_format`), candidate tender ids, the raw
  payload hash, `first_seen_at`, `last_seen_at`, `resolved_tender_id`, `resolved_at`. Unique on
  `(source, external_ref)`, so a re-seen row updates rather than duplicates. Not tenant data: no
  `organization_id`.
- `awards`, `public_tender_bids` and the ledger tables accept `ppcm` and `gnumner` as `source`.
  Their `(tender_id, lot_number, …, source)` keys already allow a second writer.
- `parties`: a party carrying a ՀՎՀՀ is matched by it first, by its per-source id second. This
  closes the case where PPCM and gnumner name the same company differently.

### One pure resolution module: the seam

- A new module holds all of ADR 0004's logic and touches no Knex, no clock and no HTTP.
  - **Resolve:** one observation from a source (source, external id, an optional pointer to
    another source's id, procedure code, submission channel, procedure type, buyer, dates, lot
    numbers) plus the candidate tenders a repository found → **link to tender X**, **create a
    new tender**, or **unmatched with reason**.
  - **Derive status:** a tender's submission channel, its source links' observed statuses and
    `now` → one `tenders.status`. Status only moves forward, and only the owning source per
    channel decides awarded and cancelled (ADR 0004 table).
  - **Normalize codes:** strip «» and quotes, map en and em dashes to `-`, collapse inner
    whitespace, uppercase.
- Matching order: an existing `(source, external_id)` link wins; then a pointer the source
  carries (a gnumner item's armeps.am `resourceId`); then normalized code + submission channel +
  dates and lots; otherwise unmatched. Two or more surviving candidates is `ambiguous`, never a
  pick.
- **In live mode, result sources never create tenders.** Only discovery and detail sources do.
- `normalizer.js` stops being eauction-specific (`mapArmepsDetail`). It becomes a thin
  orchestrator: parsed observation → resolution → repositories. e-auction ingestion must behave
  exactly as today after this refactor, and that is checked with `normalize:replay` over stored
  payloads before any new source lands.

### Sources and parsers

Each source is one adapter folder with a client and pure parsers (input in, plain object out), the
same shape as today's e-auction adapter. All share the existing politeness gate (rate limit, then
HTTP), the declared bot user agent, raw-payload storage and the zero-items-on-200 failure rule.

- **gnumner** (`gnumner.minfin.am`, TLS through the existing extra CA in `certs/`).
  - **Listing parser:** reads the announcement listings for open tenders and quotations (and
    the other procedure types' listings the same way). Each item yields title, publish datetime,
    link target and the procedure code found in the title, if any.
  - **Classification by link:** an armeps.am `resourceId` link is an ARMEPS discovery; an
    uploaded file under `/website/images/` is a paper discovery; an eauction `tmid` link is
    counted for the coverage check and otherwise skipped.
  - Uploaded files from non-public buyers (Electric Networks of Armenia's own requests, project
    implementation units) are excluded by a configured buyer list, not by guessing.
  - **Watermark:** the listing has no ids, so depth is bounded by the newest stored publish
    datetime per listing, the analogue of the tid watermark. The same rule applies: the
    watermark advances only when a chain terminates.
  - **Paper invitation parser** (`.docx`, and `.docx` inside `.zip`): procedure code, buyer,
    subject, delivery address, deadline, and lot list where present. The deadline is written as
    "N-th day counted from publication, at HH:MM" and is computed from the listing's publish
    datetime.
  - **Amendment listing** («Հրավերում կատարված փոփոխություններ»): a paper tender's deadline
    change raises a new `version`, sets `amended`, and re-notifies through the existing amendment
    path.
  - **Contract-concluded parser** (`.docx`, template 323-Ա): per lot, every bidder's name, net
    price, VAT and total, rejected bids, the winner and the contract price. It writes paper
    results and is the paper channel's award source.
  - **Failed-procedure listing** («Չկայացած»): marks ARMEPS and paper tenders cancelled.
  - **Unsupported formats:** anything other than `.docx` (including inside `.zip`) is recorded as
    `unsupported_format` and counted. The format check carries a comment for the owner: these
    formats are counted on purpose and meant to become supported once the counts show which
    ones matter.
- **armeps.am** (European Dynamics e-PPS). There is no listing (its public search errors), so
  pages are reached only through `resourceId`s that gnumner or PPCM supply.
  - **Detail parser:** buyer, titles in HY/EN/RU, procedure code, procedure type, evaluation
    method, purchase kind, CPV, deadlines and the document list.
  - Documents go to `tender_documents`. The `c4t_*.xml` tender structure is parsed for lots.
  - Owns the ARMEPS submission channel's open status and deadline.
- **PPCM** (`armeps.am/ppcm/public/…`, public JSON behind a session cookie from loading the page).
  - **Client:** obtains a session, then `POST`s report requests with the shape recorded in
    research.md. `values` is a list of `{paramId, value}` with a **plain string** value; `page` is
    `{index, size}`. Any other paging shape silently caps at 15 rows. Report and parameter ids
    live in the sources config, not in code.
  - **Per-tender results refresh** (live): for ARMEPS tenders past deadline and unresolved, and
    awarded e-auctions without bidder ՀՎՀՀ, query the organized-procedures report by procedure
    code, on a schedule like `tender.refresh`. Rows map to `public_tender_bids` and `awards` with
    `source = 'ppcm'`: `participant_total_price` is the **net** price, and `contract_price` is
    the **gross** award amount (both verified against the ledger).
  - **For e-auction tenders PPCM writes nothing but the ՀՎՀՀ** onto the matching party (same
    tender, same lot, exact net price), and never touches status or rank.
  - **Missed-tender sweep:** periodically reads the report by date window. Any row with no
    candidate tender is an unmatched result. If PPCM's bid-report supplies the `resourceId`, the
    armeps.am detail is enqueued and the result re-resolves once the tender exists. bid-report
    returned `status 500` for everything on 2026-10-18, so self-repair must degrade to "unmatched,
    counted" whenever it is unavailable.
  - Buyers are resolvable to PPCM's exact name and ՀՎՀՀ through its authority autocomplete, which
    fills a buyer party's ՀՎՀՀ.
- **eauction**: unchanged apart from the rename, and from writing its link into `tender_sources`.

### Queues and jobs

New job names go in the queue-name constants, never as string literals. Each new source gets its
sweep and refresh schedules from the scheduler, with ids derived from the source key. Paper and
ARMEPS detail fetches run on the existing fetch and normalize queues; nothing new runs in the API
process.

### API

- Tender list and detail responses carry `submissionChannel`, and detail carries the source links
  (source, URL, role).
- `GET /tenders` and `GET /tenders/relevant` accept a `submissionChannel` filter (one or more of
  the three values), validated by Joi like the other discovery filters.
- No other endpoint changes. Alerts, relevance, pipeline, reconciliation and intelligence read
  tenders, lots and ledger rows as they already do.

### Verification script

`npm run sources:verify`, beside `relevance:backtest`: prints, per source, matched vs unmatched by
reason over a date window, plus the PPCM-vs-ledger comparison (rows equal on net price, contract
equal to gross award, rejection disagreements). It prints numbers and asserts nothing.

## Testing Decisions

- **No test runner is added**, and the owner decided this explicitly for this feature. Nothing in
  this spec is blocked on one.
- **The seams are kept anyway, because they cost nothing:** every parser is a pure function from
  a payload to a plain object, and the resolution module is pure (observation + candidates +
  `now` in, a decision out). A test suite attaches to exactly these when one is wanted. The first
  tests worth writing would be a gnumner listing fixture and the resolution rules
  (re-announcement → two tenders, two candidates → `ambiguous`, never a pick).
- **What stands in for tests:**
  - `normalize:replay` over stored e-auction payloads after the normalizer refactor, which must
    change nothing.
  - `sources:verify` against the local database for the new sources.
  - Hand checks against real pages for each new parser, recorded in the ticket. Prior art is the
    PPCM-vs-ledger check in research.md (95 of 95 net prices, 28 of 29 contract prices).

## Out of Scope

- **Operator alert delivery** (Telegram to the owner). This spec only stores and counts the
  unmatched results it will read. It is a later production feature that other critical errors
  will join, and it fires on live ingestion only.
- **PPCM history backfill** (2019–2025) and creating result-only tenders from it. It is a
  deliberate, separate run with its own decision.
- **Linking an organization's supplier identity by ՀՎՀՀ.** PPCM makes it possible, but CONTEXT.md
  still says supplier identity is a human claim, and changing that is its own decision.
- **Converting `.doc`, `.rar` and scanned PDFs**, and any OCR. They are counted first.
- **The AI checklist on ARMEPS and paper documents.** The documents are stored by this work, and
  extending the extractor beyond the e-auction invitation archive is a follow-up.
- **Clarifications** («պարզաբանումներ»), and armeps.am's login-gated notices tab.
- **Mapping gnumner's `tmid` to eauction tids.**
- **Removing `tenders.source_id`** once readers have moved to `tender_sources`.
- Two-stage, restricted and other rare procedure types are ingested only where their listing has
  the same shape; no special handling.

## Further Notes

- **Build order** (`/to-tickets` should keep it):
  1. rename
  2. schema
  3. resolution module + normalizer refactor on e-auction alone
  4. gnumner listing
  5. armeps.am detail
  6. paper discovery + amendments
  7. paper results
  8. PPCM results for ARMEPS + ՀՎՀՀ for e-auctions
  9. missed-tender sweep
  10. API filter
  11. `sources:verify`

  Customers see all three submission channels after step 6, and intelligence grows after steps 7
  and 8.
- **PPCM coverage is partial by nature:** 12 of 24 awarded e-auctions were present on 2026-10-18,
  and the misses were filing lag or buyers that never file. Benchmarks drawing on it must keep
  stating sample size and distinct tenders, as they already do. Never present PPCM as the whole
  market.
- **Verify the paper deadline rule on real cases before trusting it.** It is unconfirmed whether
  "7th day counted from publication" includes the publication day, and whether it uses calendar or
  working days. Get it wrong and every paper deadline is off by a day, which is the worst error
  this channel can make.
- **Live ingestion must not create load on gnumner or PPCM beyond eauction's.** Both are
  government sites that went down the night of 2026-10-17. Use eauction's rate limits as the
  ceiling, and politeness over freshness for results, since results are not time-critical.
- **gnumner's listing pagination totals are unreliable** (one listing reported 589 pages while
  another of similar volume reported 29). Rely on the watermark, never on the page count.
