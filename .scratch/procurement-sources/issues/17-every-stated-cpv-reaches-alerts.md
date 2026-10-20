# 17 — Every CPV a tender states reaches alerts, discovery and relevance

**What to build:** A supplier whose saved search names any CPV code a tender states hears about
that tender, finds it with the CPV filter, and sees it ranked, even when the source does not say
which lot the code belongs to. Found in ticket 05: in tender 12543482, `09211150` is on the armeps.am
page but on neither the tender nor a lot, so a saved search on it misses the tender. A missed
tender is the #1 churn cause.

**Blocked by:** None — can start immediately (ticket 05 is done).

**Status:** done

Today `tenders.cpv_code` holds one code. Lots get a code only where a lot name starts with that
code's label (88 of 92 lots in ticket 05's sample). The matcher reads `cpvCode` plus the lot
codes; the discovery filter and relevance read the lot codes.

- [x] A tender keeps **every** CPV code its source states, not only the first: a `text[]` column
      beside `cpv_code` (which stays as the primary code, so no reader breaks). Mapping a code to a
      lot stays where it is; an unmapped code is still a fact about the tender.
- [x] armeps.am writes all its codes. e-auction writes the codes from its invitation archive.
      Paper writes whatever its invitation states (ticket 06), or nothing.
- [x] The matcher, the discovery CPV filter and relevance read tender codes ∪ lot codes, each
      through the one CPV rule in `libs/cpv.js`. No reader keeps its own list.
- [x] Relevance weights and `MATCH_THRESHOLD` are unchanged. Only the set of codes considered grows.
      Re-run `relevance:backtest` and record the before and after top-10 rate. A drop is a finding
      to raise, not to tune away here.
- [x] Schema change through the four-step workflow. Existing tenders are backfilled from their
      stored payloads (armeps.am pages, e-auction invitation archives), not re-crawled.
- [x] Verified: a saved search on `09211150` matches 12543482. Record how many tenders gained codes
      and how many new matches the backfill would raise, before any alert job is allowed to fire
      (a backfill must not alert on old tenders).

## Verification — 2026-10-20

Against the local database `tendra`, local MinIO and local Redis. No worker was running at any
point, so nothing could consume a job, and none was added (below).

**Schema.** `migrations/add_tender_cpv_codes.js` (`tenders.cpv_codes text[] NOT NULL DEFAULT '{}'`
and a GIN index `tenders_cpv_codes_idx`) run twice on `tendra` (`columnAdded: true`, then
`false`), mirrored into `create_table.js`, deleted in the next commit
(`git show <that commit>~1:migrations/add_tender_cpv_codes.js`). **Neon is not touched**:
whoever migrates it runs that script, then `npm run cpv:backfill` (dry run), then
`npm run cpv:backfill -- --apply`, with tickets 01, 05 and 14's scripts.

**Backfill from storage** (`npm run cpv:backfill`; nothing re-crawled):

| | |
|---|---|
| tenders read (empty list) | 1,206 |
| a stored page / archive to read | 1,141 (54 armeps.am CfT pages, 1,087 e-auction invitation archives) |
| no stored payload | 65 (e-auction tenders whose invitation was never downloaded — they keep `[]`) |
| **tenders that gained a code** | **1**: `armeps:12543482` +`09211150` (4,802 codes in all were written, every other one already on a lot or the primary) |
| new matches it would raise, saved searches as they stand | **0** (the local database has no saved search) |
| the same, with a throwaway search on `09211150` | 1 organization, 1 on a live tender |
| written by `--apply` | 1,141, then a second run reads only the 65 and writes 0 |

**No alert.** The script writes `cpv_codes` and nothing else: no version, no event, no job. The
newest job in `bull:alerts` was queued at 01:03 that day, hours before the backfill ran;
`notifications` held 0 rows before, during and after.

**Verified: a saved search on `09211150` matches 12543482.** With a throwaway user, organization
and saved search (`cpv_codes = {09211150}`, no channel), read without the alert job so no
notification is written:

| reader | before the backfill | after |
|---|---|---|
| matcher (`matchesByOrganization` over `findDetail`, as the job builds it) | no match | match, 0.7, `exact CPV match` |
| `GET /tenders?filter[cpv]=09211150` (`TenderService.search`) | `[]` | `armeps:12543482`, `cpvCodes` `["09211110","09211150","24951320"]` |
| relevance (`TenderService.relevant`) | #1, 0.231, `saved_search` `group` via the primary `09211110` | #1, 0.33, `saved_search` `exact`, `covered`, `cpvCode 09211150`, `lot: null` |

The throwaway rows were deleted.

**Re-reading changes nothing.** 12543482's list was emptied again, then every stored detail page
(1,152 e-auction, 54 armeps) went through the production `normalizeTender`: **1,206
unchanged, 0 events, 0 versions moved**, and 12543482's list came back filled — a blank filled
by a re-read is not an amendment. Through `saveNormalized` on 12543482, then restored to version
1: the same codes in another order → no event; one code dropped → `TenderAmended`,
`changedFields: ["cpv_codes"]`.

**`relevance:backtest`, before and after** (default cut-off 2026-09-18T08:45Z, 174 tenders
biddable, 324 suppliers). "Before" ran before the migration; "after" ran after `--apply`.

| | before | after |
|---|---|---|
| rankable, 132 suppliers, 472 real bids — top 10 | 40.7% | 40.7% |
| top 20 / median position / MRR | 65.9% / 8.0% / 0.353 | 65.9% / 8.0% / 0.353 |
| thin, 192 suppliers, 302 real bids — top 10 | 9.9% | 9.9% |
| top 20 / median position / MRR | 17.5% / 50.3% / 0.072 | 17.5% / 50.3% / 0.072 |

Identical at 6, 12 and 24 months (random top 10: 5.7%). **This is not evidence of no
regression — the backtest cannot see this change.** Its candidates and ledger are e-auction
only, and an e-auction's archive codes were already on its lots; the one tender that gained a
code is an ARMEPS tender published after the cut-off. Re-run it once ARMEPS results (ticket 10)
put ARMEPS tenders in the ledger.

### Decided while building

- **`cpv_codes` is a sorted set**, primary included, `[]` for none. The order a page prints its
  codes in is not a fact about the tender, so it never reads as an amendment.
- **One list, two spellings.** `libs/cpv.js#tenderCodes` (matcher, relevance) and
  `tender.repo.js#tenderCodesSql` (the CPV and field filters, the pipeline's codes) both read
  primary ∪ `cpv_codes` ∪ lot codes. Nothing pins the SQL twin to the JS one — they must move
  together.
- **`filter[cpv]` stays an exact-code test over that list**, not `covers`. So a saved search on
  `30000000` alerts on a tender that `filter[cpv]=30000000` does not return. That was true before
  this ticket. Making the filter hierarchical changes what an existing API call returns, which is
  a decision of its own, not part of "the set of codes grows".
- **The ledger's category stays the lot's code** (`relevance.repo.js#ledgerFor`,
  `coalesce(l.cpv_code, t.cpv_code)`): a bid is on one lot, and a tender-wide list would put a
  bid in categories its lot is not in. It reads nothing new today (the ledger is e-auction only).
- **A page-stated list that moves is an amendment; a blank filled is not.** Without the second
  half, the first armeps refresh after the deploy, before anyone ran the backfill, would have
  re-notified every matching organization about every ARMEPS tender.
- **An e-auction's list is replaced by its invitation archive** (`applyInvitationFacts`), like
  its lots, and raises no event. armeps.am passes none there; its page's list stands.
- `matchCandidate` and `ALERTABLE_STATUSES` moved from the alert job into
  `matcher.service.js`, so the backfill counts matches with exactly the candidate the job builds.
- `cpvCodes` is on the list, detail and relevant responses (`docs/API_REFERENCE.md`).

### Found, not fixed here

- **Ticket 25.** An e-auction's codes never reach its ingest alert: of 851 e-auction match jobs
  in `bull:alerts`, all 787 whose tender has an invitation were queued **before** the invitation
  was stored. So the matcher saw no code at all. This ticket widens which codes the matcher
  reads; ticket 25 is about when it reads them.
- **The 54 match jobs still waiting in `bull:alerts`** (ticket 05's ARMEPS ingests; the other
  1,000 already ran) will run on the next `npm run worker`, now with `cpv_codes` filled. With no saved search locally that is harmless;
  on a database with real searches, a match job queued long ago is an alert on an old tender.

### Review (`/code-review`, standards and spec)

No hard standards violation. Fixed from it: `sameCodes` for the two list comparisons in
`tender.repo.js`, and `codesSet` renamed `codesReplaced`. Fixed from the spec review: CLAUDE.md
now says only a page-stated list is an amendment, and this record says the backtest cannot see
the change.

Left, on purpose:
- `relevance.repo.js` imports `tenderCodesSql` from `tender.repo.js`. A repository importing a
  repository has precedent, there is no cycle, and a helper module for one fragment would be a
  third place to look.
- The backfill builds `detail:` / `invitation:` refs and splits `tenders.source_id`, as
  `replayNormalizer.js` and the workers already do. Reading `tender_sources` instead belongs to
  the ticket that moves readers off `source_id`.
- `filter[cpv]` exact vs `covers`, above.
