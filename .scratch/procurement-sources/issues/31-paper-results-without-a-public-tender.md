# 31 — Paper results of procedures that were never announced publicly

**What to build:** The prices in gnumner's contract-concluded notices reach intelligence even when
the procedure was never announced on gnumner. That covers most quotations, which are sent straight
to invited suppliers, and every single-source procedure. A notice like that is **not** counted as
"Tendra missed a tender", because there was nothing public to miss. Found in ticket 08: about 780
notices, only one of which belonged to a published quotation.

**Blocked by:** None. Ticket 08 is done.

**Status:** done

**Decided 2026-10-23, an amendment to ADR 0004.** The ADR's rule is that "in live mode, result
sources never create tenders", and its one exception is the PPCM history backfill: results whose
tender no discovery source will ever show. These notices are the same case, live. Under the
current rule, about 99% of paper price data is thrown away. Worse, it is recorded as
`no_candidate`, which the planned operator alert reads as a coverage failure, so the real misses
would drown in the noise.

- [x] **Tell "never public" from "missed", from facts, not guesses.**
  - If the notice's invitation date falls inside the window the gnumner sweeps fully cover, and no
    gnumner invitation with that code and buyer was ever seen, the procedure was **not public**.
  - A single-source procedure (its procedure type, from the code or the template) is never public.
  - Outside the covered window, it is unknown: keep it `no_candidate` as now.
  - Record how the covered window is computed (watermarks plus the cold-start depth).
- [x] A not-public notice creates a **result-only tender**:
  - `submission_channel = 'paper'`, the procedure type from the notice, status `awarded`;
  - a `gnumner` link with role `results`, buyer, code, the bids and awards from the parser;
  - **never biddable** and never alerted: no `match.tender` job, ever.

  It is the same shape as a PPCM-history tender.
- [x] **Single-source results are kept out of competitive comparisons.** A single-source price is
      what a buyer agreed with one supplier, not what a market bid. Competitor prices and
      benchmarks exclude `procedure_type = 'single_source'` unless asked for explicitly. Record
      how the benchmark tiers treat it, and that `insufficient_data` still holds.
- [x] Notices that are genuinely `no_candidate` (inside the covered window, the code was public,
      and Tendra lacks the tender) stay unmatched and counted. Those are the ones the operator
      alert is for.
- [x] The `unsupported_format` counts can be read **per notice kind** (invitation, amendment,
      contract; single-source vs competitive), so ticket 13's converter decision is not skewed
      by single-source notices (12 of 18 unreadable today).
- [x] ADR 0004 gets a short amendment naming this second exception. Discovery still never
      receives these tenders: they are absent from `GET /tenders` biddable lists by construction.
- [x] Re-processing the about 780 stored notices raises no alert. Record how many became
      result-only tenders, how many stay `no_candidate`, and how many stay unknown.
- [x] If you add a migration, add it to ticket 30's list.

## Verification (2026-10-23, local Postgres `tendra`, MinIO, Redis `localhost:6379`)

No worker was running, and nothing was fetched from gnumner: everything below reads storage.
There is no test runner, so the pure rules are checked by 62 `node:assert` assertions in a
scratch script, and everything else by hand on the stored data.

**Not 780: 31 notices are stored.** The ~780 notices in ticket 08 were a scan of listing pages.
Only the cold start's 30 uploads and `765109bf` (page 127) were stored, so those 31 are the
ones re-processed here.

**Migration.** `migrations/add_listing_notices.js` was run twice; the second run was a no-op.
It is mirrored into `create_table.js`/`drop_table.js` and listed as ticket 30's step 10.
`npm run notices:backfill`: 27 stored listing pages → 134 notices (open and quotation, armeps
and paper links), the same count on a second run.

**The covered window, locally.** The two cold starts of 2026-10-19 predate floors, so each
listing's floor was set by hand to the oldest notice on its stored cold-start page 5, which
is what the chain would have written:

- `open`: 10-14 06:32Z → watermark 10-19 13:14Z;
- `quotation`: 10-19 06:51Z → watermark 10-19 16:30Z.

The intersection is less than a day, so no invitation day ±1 fits inside it. **Five pages of
`quotation` are about ten hours, not three days** (the comment in `sources.config.js` says
three days; that file holds the owner's uncommitted rate-limit edits, so it was left alone).

**The 31 stored notices, re-read through `recordContract`** (all twice, then a third time
after the review fixes):

| outcome | n | |
|---|---|---|
| result-only tender | 1 | `55ce0ac2`, ՀՀԱՄ-ԱՐԵՎՈՒՏ-ՄԱԾՁԲ-26/24, single-source |
| unsupported_format, `was_public` false | 11 | single-source (`ՄԱ` codes): .doc 4, .pdf 4, .rar 2, .zip 1 |
| no_code, `was_public` false | 1 | `5d653efd`, «B6272274368», single-source by its article 23 |
| no_candidate, `was_public` null (**unknown**) | 10 | competitive, invitations 09-10 → 10-11, outside the window |
| unsupported_format, `was_public` null | 7 | competitive (6) or no code (1) |
| linked, as before | 1 | ԳՀԱՊՁԲ-ՀՎԿԱԿ-2026-66, ticket 08's tender |

So: **1 became a result-only tender**, **0 stay `no_candidate` as a real miss**, and **10 stay
unknown**, with 7 unreadable unknowns beside them.

- **No alert.** The alerts queue's counts were identical before and after every run. No
  `match.tender` was queued, and no contract retry. The one benchmark job the first run
  queued was run in process (0 categories: no CPV) and removed. The code no longer queues it.
- **Nothing else moved.** Content checksums with the new tender's own rows excluded:
  `tenders`, `tender_sources` and `parties` are byte-identical to before. The `awards` and
  `public_tender_bids` content is identical across runs; their ids churn, because
  `recordResults` rewrites a ledger, as in ticket 08.
- **Idempotent.** The second and third runs linked the result-only tender by rule 1: it
  stayed `awarded` v1 and raised no event.
- **Details unaffected.** All 1,230 stored detail payloads were re-resolved read-only: 1,223
  `link` to their own tender, 5 `unsupported_format`, 2 `superseded`. These are ticket 08's
  replay numbers, plus one payload stored since then.

### By hand: the result-only tender against `55ce0ac2` (bc8646e0.docx)

| | document | written |
|---|---|---|
| procedure | «23-րդ հոդվածի 1-ին մասի 4-րդ կետ», code `…-ՄԱԾՁԲ-…` | `single_source` (both agree) |
| invitation | 19.10.2026 | `published_at` 10-19 Yerevan |
| buyer | «Արեվուտի համայնքապետարանը ստորև ներկայացնում է …» | party `Արեվուտի համայնքապետարան` (`gnumner:buyer:…`) |
| lot 1 | budget 127 800; «Ղազար Սարգսյան» Ա/Ձ 127 800, VAT blank, 127 800 | bid net = total 127 800, VAT 0, no rank |
| contract | «Ղազար Սարգսյան» Ա/Ձ, signed 20.10.2026 | award 127 800 / net 127 800, `awarded_at` 10-20 |

The tender was written as `paper`, `awarded`, v1, with one `gnumner` link of role `results`.
It has no deadline, CPV, lots or address, and `source_id` is `gnumner:contract:55ce0ac2…`.
The notice's unmatched row is resolved to it.

### Intelligence

- **`competitor-prices` on it** answers `single_source` with no lots.
  `includeSingleSource: true` gives the ledger: 1 bidder, `sole`, the winner at
  127 800 / net 127 800. Ticket 08's paper tender is unchanged: lots 1 and 5 go to Ագաթոն
  at 805 800 and 2 227 500.
- **Expected competition** (the corpus tier): 6,420 lots, or 6,421 with single source; sole
  lots 1,992, or 1,993.
- **Benchmarks.** The tender was given 31682100 for one call, then set back to NULL:
  - `statsFor` exact: 4 awards, or 5 with single source;
  - `comparableAwards` holds it only when asked;
  - `buyerCategoryPairs` never holds it.
- **How the tiers treat it.** `compute`'s exact tier is 4, below the threshold of 5, so it falls
  to `cpv_family` (7). Asked to include single source, the exact tier reaches 5, and the
  answer says `includesSingleSource`. That is why it is opt-in only.
- **`insufficient_data` still holds.** On a category only it holds (50112000), the answer is
  `insufficient_data` either way (0, or 1 with single source).
- **Biddable lists** (`findBiddableAsOf`) never hold it.

### The rules and the chain

- **The 62 assertions** cover:
  - the method marker on 16 codes (ՀՄԱԾՁԲ and ԿՄՋՀ-ԾՁԲ are null);
  - the span's edges (the day ±1, strictly above the floor, at or below the watermark);
  - `wasPublic` in each branch;
  - `resolve`: create, unknown, a real miss, no date, no buyer, no type, no award, the
    single-source rows that are unreadable or have no code, a code held on e-auction, a
    same-day paper tender (link), a result-only tender taking another lot, a paper re-post
    never joining one, and a replay linking by rule 1;
  - `nextStep`'s `capped`.
- **The floor through the real `readListingPage`**, with a stub board and no network:
  - a cold start sets it;
  - a chain that reaches the watermark leaves it;
  - a chain stopped by the page ceiling raises it to what it read;
  - a stalled pager moves nothing.

  The stub's pages, rows and keys were removed afterwards, and `sweep:ok:gnumner` was
  restored.

## Decided while building

- **"Seen" is asked of the listings, not of tenders.** The new table `listing_notices` holds
  every entry of the `open` and `quotation` listings, ingested or not: an e-auction link, an
  excluded buyer, an unknown link. A notice whose job failed or whose file nobody could read
  leaves no tender, and was still published. A title with no code takes its tender's code,
  through its discovery link.
- **A code-less notice near the date blocks "never public".** If a notice whose code nobody
  knows was published within the invitation day ±1, it could be that procedure's notice, so
  the answer is unknown. Locally that blocks a lot, because many queued jobs never ran. Live,
  only titles with no code whose file was unreadable remain.
- **The span is the invitation day ±1.** The date is typed by the buyer, so a slip must not
  turn a public invitation into a private one at the window's edge.
- **The floor is one unbroken stretch.** A gap left by the page ceiling raises the floor
  rather than recording islands. What lies below a gap is forgotten, never vouched for. The
  floor is written before the watermark.
- **All invitation listings at once.** The window is the intersection of `open` and
  `quotation`, because buyers file quotations on the open-tender listing too.
- **Single source** comes from the code's `ՄԱ` marker or the notice's procedure row. That row
  names the procedure, or cites article 23 (single source) or 22 (quotation): every `ՄԱ` code
  in the corpus cites 23 and every `ԳՀ` code 22. If the two disagree, the type is null. «ՄԱ
  գնման» in a title is not read; that would be a guess.
- **"Seen" outranks the marker.** An invitation of the code on the listing makes the procedure
  public, whatever the code says.
- **A result-only tender needs a code, an invitation date, a buyer, a procedure type and an
  award.** Without the date no later notice could join it by rule 3, and every notice of the
  procedure would be a tender of its own. A notice that is never public but lacks any of these
  stays `no_candidate` with `was_public` false, so it is not a miss.
- **A later notice joins a result-only tender** by rule 3 without the lot check, since its lots
  are only the ones notices have named so far. A paper invitation never joins one as a
  re-post. Its create takes the same lock on the code as a paper run's.
- **`unmatched_results.was_public`** is set on every unmatched contract notice, not only on
  `no_candidate`. The operator alert's row is `no_candidate` **and** `was_public`.
- **Single source in intelligence.** Single-source tenders are left out of every benchmark
  tier, comparable awards, the materialised sets and expected competition, and
  `filter[includeSingleSource]=true` puts them back, with the benchmark then computed live.
  The first cut also made a single-source tender's own competitor prices answer
  `status: 'single_source'`; the follow-up below overruled that.
- **`procedure_type` on unmatched invitation and amendment rows.** An invitation takes its
  listing's type, so the 5 rows recorded before the column existed say `unknown`: a re-read
  has no notice to take the type from. An amendment takes its code's type.

## Review (`/code-review`, standards and spec)

Fixed from it (assertions, notices, checksums re-run after):

- **`result_only` read a tender with no links as result-only.** It is now exact (a `results`
  link and no other). `tendra` has no link-less tender, so nothing moved.
- **The index left out e-auction links, other links and excluded buyers' uploads** on the
  invitation listings, yet the window vouched for them. Every entry is now indexed, on every
  read.
- **A never-public notice with no invitation date could create a tender** that no later notice
  can join. It now stays unmatched.
- **The benchmark job for a result-only tender was a no-op**, since it has no CPV. It is no
  longer queued, and the comment no longer claims its prices reach benchmarks.
- `allByPrefix` takes `trx`, and the window shares `invitationListings` with the board.

Left, on purpose:

- ~~**`status: 'single_source'` on competitor prices**~~ was overruled by the follow-up below.
  The exclusion from expected competition stands.
- **A relink of an existing paper tender can still queue `match.tender`** when its status
  moves. That is ticket 08's path, and the matcher's open rule silences it. A result-only
  tender never moves.
- **A corrected notice whose invitation date differs** («/շտկված/», ԼՄԱՀ-ՀՄԱԾՁԲ-26/44 is dated
  09-16, then 09-25) would be a second result-only tender if it were never public. Rule 3 is
  kept strict rather than joining on code and buyer alone.
- **Listing blocks the parser skips** (no link, no date) are counted by the sweep, but they
  are not in the index.

## For the owner

- **Competitive notices start qualifying weeks after the first live sweep.** A cold start
  covers about ten hours of `quotation`, and contracts are filed weeks after their
  invitations. Until then, only single-source notices become tenders.
- **Result-only tenders have no CPV**, so they reach competitor prices, expected competition
  and profiles, but not benchmarks.
- **`sources.config.js` says five pages of gnumner are about three days.** For `quotation`
  that is about ten hours (50 notices a day).
- **Re-processing stored notices** is a script today, not an npm command:
  `recordContract` for each `contract:` payload. A `contracts:replay` is a short addition if
  it is wanted.

## Follow-up: a single-source tender's own ledger is shown (decided 2026-10-23)

**Decision (the owner's, overruling the first cut).** For a single-source tender,
competitor-prices returns that tender's own ledger by default, flagged so a client can say
"single source, no competition". Excluding single source applies only to **aggregates across
tenders**: benchmarks, expected competition, profiles and price ranges.
`filter[includeSingleSource]=true` still opts in.

**Built.**

- `competitor-prices` lost its `single_source` status. Both of its answers carry
  `singleSource: true|false`, and `includeSingleSource` now touches only the
  `expectedCompetition` beside the ledger.
- **Profiles** were an aggregate that still counted single source. Supplier and buyer profiles
  now leave it out (`profile.repo.js#scoped`, every query), unless
  `filter[includeSingleSource]=true` on `GET /suppliers/:id/profile` and `/buyers/:id/profile`
  (a new `profileQuerySchema`). An opted-in profile says `includesSingleSource`.
- The nightly `computeAll*` rebuild never includes single source. So a buyer's `spend` and
  `volume` are its **competitive** spend and tenders; asking includes the rest.
- **Price ranges across tenders** were already covered: the recommendation's observed range
  comes from benchmarks and comparable awards. The `priceRange` in competitor prices is one
  tender's own lot and is not filtered.
- The filter is one SQL helper, `tender.repo.js#competitiveOnlySql`, which replaces the three
  copies the review counted. `docs/API_REFERENCE.md`, CLAUDE.md and ADR 0004 are updated.

**Verified (local `tendra`, read-only):**

| | default | `includeSingleSource` |
|---|---|---|
| competitor prices, ՀՀԱՄ-ԱՐԵՎՈՒՏ-ՄԱԾՁԲ-26/24 | `ok`, `singleSource: true`; lot 1, 1 bidder, `sole`, «Ղազար Սարգսյան» Ա/Ձ 127 800 / net 127 800, range 127 800 | identical lots; corpus expected competition 6,420 → 6,421 lots |
| competitor prices, ԳՀԱՊՁԲ-ՀՎԿԱԿ-2026-66 (ticket 08, quotation) | `ok`, `singleSource: false`; lot 1 Ագաթոն 805 800 / net 671 500 vs Մեյդ թու Մեյք 1 197 083; lot 5 Ագաթոն 2 227 500 / net 1 856 250 vs 2 004 750 | identical lots; 6,420 → 6,421 |
| supplier profile, «Ղազար Սարգսյան» Ա/Ձ | 0 bid, 0 won, `no_data` | 1 bid, 1 won, win rate `insufficient_data`, 127 800 won |
| buyer profile, Արեվուտի համայնքապետարան | 0 tenders, no spend, no top suppliers | 1 tender, 127 800 spend, top supplier «Ղազար Սարգսյան» Ա/Ձ |
| supplier profile, Ագաթոն ՍՊԸ (no single source) | 2 bid, 2 won | the same |
| nightly rebuild | neither party holds a row from it | — |

The query schemas convert `'true'` and `'false'` and strip unknown parameters.

## Second follow-up: competition is filtered, totals are split (decided 2026-10-23)

**Decision (the owner's).** The line is "does this figure measure competition?", not "is it
an aggregate?".

- **Figures that measure competition** exclude single source unless the request opts in, as
  before: win rate, discount from budget, bidder counts, price comparisons and benchmarks.
- **Totals count everything and carry a competitive / single-source split:** a buyer's spend
  and volume, and a supplier's contract count and revenue.

A buyer whose contracts are all single-source shows its spend, not an empty profile. This
replaces the first follow-up's "profiles leave single source out", including its spend caveat.

**Built (`profile.repo.js`, `profile.service.js`).** Each query is either `competitive(…)`,
which applies the window and the competitive filter unless asked, or `withinWindow(…)`, which
counts everything. A query that mixes the two filters the competition figure inside the
aggregate.

- **Supplier.**
  - Competition: `activity`, `winRate`, `pricing` and `frequentRivals`. `activity.lotsWon` is
    the win rate's numerator.
  - New `contracts`: lots, tenders, total value and largest, every award counted, with
    `split.{competitive,singleSource}`. It takes over `pricing.totalWon`/`largestWin`, which
    were revenue.
  - `categories` counts every bid: what a company covers, not how it competes.
- **Buyer.**
  - Totals: `volume` (with `split`), `spend.totalSpend`/`totalBudget`/`totalEstimated` (with
    `spend.split`), and `topSuppliers`, each with `singleSourceAwards`.
  - Competition: `spend.avgDiscountPct`, `spend.distinctWinners` and `competition`.
- **Nightly rebuild.** `supplier_profiles.win_rate` and `avg_discount_pct` are competitive,
  and `categories` counts everything. Every bidder gets a row: a single-source-only supplier
  has `lotsBid` 0, so its win rate is null. `buyer_profiles` (`total_spend`, `tender_count`,
  `favored_supplier_ids`) counts everything. No column is added; the split is the API's. The
  per-party `recompute*` reads the same queries.

**Verified (local `tendra`, read-only; nightly rows computed, not written):**

| | default | `includeSingleSource` |
|---|---|---|
| buyer Արեվուտի համայնքապետարան | 1 tender, spend 127 800 (competitive 0 / single source 127 800); 1 lot awarded (0 / 1); discount null, 0 winners, competition 0 lots; top supplier «Ղազար Սարգսյան» Ա/Ձ, 1 award, 1 single source, 100% of spend | totals the same; discount 0, 1 winner, 1 lot, 1 sole bidder; `includesSingleSource` |
| buyer NCDC (ticket 08's) | 1 tender, spend 3 033 300 (3 033 300 / 0); discount 4.08, 1 winner, 2 lots, 0 sole; Ագաթոն 2 awards, 0 single source | the same |
| supplier Ագաթոն ՍՊԸ | 2 bid, 2 won (`insufficient_data`); discount 4.08 / 4.08; contracts 2 lots, 3 033 300 (2 / 0); 1 rival | the same |
| supplier «Ղազար Սարգսյան» Ա/Ձ | 0 bid, 0 won (`no_data`); contracts 1 lot, 127 800, all single source | 1 bid, 1 won (`insufficient_data`); contracts unchanged |
| nightly | Արեվուտի: 1 tender, 127 800, «Ղազար Սարգսյան» paid; NCDC: 1, 3 033 300, Ագաթոն; Ագաթոն: 2 bid, 2 won, 4.08; Ղազար: a row with 0 bid (win rate withheld) | — |

The nightly supplier rows number 757, one for each of the 757 bidders.
