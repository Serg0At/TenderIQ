# 03 — One resolution module; the normalizer stops being e-auction-specific

**What to build:** All of ADR 0004's merge logic lives in one pure module, and e-auction ingestion
runs through it with no visible change. After this, adding a source means writing a parser that
emits an observation, never touching merge rules. Unresolvable results are kept as unmatched
results. Spec: *One pure resolution module: the seam*.

**Blocked by:** 02

**Status:** done

- [x] **Resolve:** a pure function (no Knex, no clock, no HTTP) takes one observation (source,
      external id, an optional pointer to another source's id, procedure code, submission channel,
      procedure type, buyer, dates, lot numbers) plus candidate tenders, and returns one of: link
      to an existing tender, create a new tender, or unmatched with a reason.
- [x] Matching order is ADR 0004's:
  - an existing `(source, external_id)` link;
  - then a pointer the source carries;
  - then normalized procedure code + submission channel + dates and lots.

  Two or more surviving candidates is `ambiguous`, never a pick. A result source never gets
  "create" in live mode.
- [x] **Derive status:** a pure function takes the submission channel, the links' observed
      statuses and `now`, and returns one `tenders.status`. Status only moves forward, and only
      the owning source per channel (ADR 0004 table) decides awarded and cancelled.
- [x] **Normalize code:** strips «» and quotes, maps en and em dashes to `-`, collapses inner
      whitespace and uppercases. `ՍԱՊ–ԳՀԱՊՁԲ-26/18` and `«ՍԱՊ-ԳՀԱՊՁԲ-26/18»` normalize equal.
- [x] `unmatched_results` exists (source, external ref, procedure code, reason
      `no_candidate | ambiguous | no_code | unsupported_format`, candidate tender ids, payload hash,
      first and last seen, resolved tender, resolved at) and is unique on
      `(source, external_ref)`. A repository records and re-sees rows idempotently.
- [x] The normalize worker is a thin orchestrator (parsed observation → resolve → repositories),
      with no e-auction mapping inside it. The e-auction mapping moves next to its parser.
- [x] `npm run normalize:replay` over every stored e-auction payload changes nothing: same
      tenders, statuses, versions, lots, ledger rows and awards. Record the before and after
      counts in this ticket.
- [x] The six re-announced codes in the local DB (for example `ԵՔ-ԷԱՃԱՇՁԲ-26/11`) are still two
      tenders each.

## Verification — 2026-10-19

Run against the local database `tendra` (the only active one; Neon holds a stale snapshot and was
**not** migrated) and the local Redis, with the workers stopped. The fetch queue held 1534 pending
jobs, so the replay was drained by a consumer of `ingest.normalize` **only**, never by the full
worker.

**Where it lives.** `services/resolution.service.js` (pure: `normalizeCode`, `lookupsFor`,
`resolve`, `deriveStatus`, `STATUS_OWNERS`); `libs/adapters/source/eauction/observation.js` (the
e-auction mapping and the two layout alarms, beside the parser); `repositories/unmatchedResult.repo.js`
(`record`, `markResolved`); `tender.repo.js#findCandidates` and `saveNormalized({ tenderId })`.
`workers/normalizer.js` is observe → `findCandidates(lookupsFor(…))` → `resolve` → `deriveStatus`
→ `saveNormalized`, with no e-auction mapping in it.

**Migration** (`migrations/add_unmatched_results.js`, committed with the feature and deleted in the
next commit): first run created the table, second run `tableCreated: false`. A fresh database built
by `create_table.js` matches the migrated one on the table's columns, defaults, constraints and
indexes (`information_schema` / `pg_constraint` / `pg_indexes` diff: identical). An insert with
reason `guessed` is refused by `unmatched_results_reason_chk`.

### `npm run normalize:replay` — before and after

A fingerprint of every row (count + md5 of each row) was taken before anything ran, then after a
baseline replay on the **old** normalizer, then after a replay on the new one (run again after the
review fixes; the numbers are from that final run).

| | before | baseline replay (old code) | replay (new code) |
|---|---|---|---|
| payloads queued / completed / failed | — | 1152 / 1152 / 0 | 1152 / 1152 / 0 |
| events (`TenderIngested` / `TenderAmended`) | — | 0 / 0 | 0 / 0 |
| `tenders` | 1152 | 1152 | 1152 |
| — status active / closed / awarded / cancelled | 267 / 367 / 332 / 186 | same | same |
| — version 1 / 2 | 1023 / 129 | same | same |
| `parties` | 939 | 939 | 939 |
| `awards` | 5580 | 5580 | 5580 |
| `public_tender_bids` | 19978 | 19978 | 19978 |
| `tender_lots` | 10161 | 10161 | 10161 |
| `tender_sources` | 1152 | 1152 | 1152 |
| `tender_documents` | 1087 | 1087 | 1087 |
| `unmatched_results` | — | — | 0 |
| row-md5 fingerprint of all of the above | — | identical | identical |

The fetch, maintenance and alerts queues held the same job counts before and after: no alert,
benchmark or document job was raised.

**Re-announced codes.** All six (`ԱՄԱԿ-ԷԱՃԱՊՁԲ-26/40`, `ԱՄՄՀ-ԷԱՃԱՊՁԲ-26/97`, `ԵՔ-ԷԱՃԱՇՁԲ-26/11`,
`ԷԲԿ-ԷԱՃԱՊՁԲ-26/51`, `ՀԳՊԱ-ԷԱՃԾՁԲ-26/46`, `ՀՀԿԳՄՍՆԷԱՃԱՊՁԲ-26/161`) are still two tenders each after
the replay.

**The create path**, which a replay never reaches. In a throwaway database built by `migrate:up`
(Redis DB 15, so no job reached the real queues), the payload rows for the 12 re-announced tids and
30 random others were normalized oldest tid first, then again:
- Pass 1: 42 `TenderIngested`. Pass 2: 42 unchanged.
- The six codes came out as two tenders each, and `unmatched_results` stayed empty.
- Compared with `tendra` field by field (tender, buyer name, status, link, 669 ledger rows, 228
  awards), they were identical except `first_seen_at` on 3 links. Each of those tids has two stored
  payloads, and the throwaway run normalized only the latest one. That comes from the test setup,
  not the code.

**Resolution rules**, checked by hand with `node:assert` (no test runner, by decision):
- `ՍԱՊ–ԳՀԱՊՁԲ-26/18` and `«ՍԱՊ-ԳՀԱՊՁԲ-26/18»` normalize equal. `ՀՀ   ՊՆ-…` keeps one inner space.
- A detail page with a known code creates a tender, and no code lookup is even asked for it. A
  linked pair wins, and a pointer links.
- A result with no code is `no_code`, and no result ever gets `create`.
- On a result, two runs published the same day are `ambiguous`. Dates one day apart (on the Yerevan
  calendar, so 20:30Z counts as the next day) pick the right run. A result with **no** comparable
  date is `no_candidate`, even against a single run.
- Status: only the owning source counts (a `ppcm` "awarded" on an e-auction is ignored), status
  never moves backwards, a terminal status sticks, and an unmapped label falls back to the
  deadline.

**Repository, against `tendra`.**
- `codeKeySql` (the SQL twin of `normalizeCode`) equals the JS key on all 5760 variants: each
  stored code, plus quoted, en-dash, em-dash and padded forms of it.
- The first comparison found one real mismatch. JavaScript uppercases the ligature `և` to `ԵՒ`;
  Postgres leaves it alone, so `ՀՀ ԱԱԾ-ՏԱևԿԿԳՎ-…` never reached the candidates. The fix replaces `և`
  in SQL first.
- For the six re-announced codes, a results lookup returns both runs. With one run's dates it links
  that run, for five of the six.
- The sixth, `ՀԳՊԱ-ԷԱՃԾՁԲ-26/46`, stays `ambiguous`. Its runs (tids 48135 and 48140) were published
  69 minutes apart with the same deadline, so no date can tell them apart. That is the rule working.
- `unmatched_results`: eight records for one ref (five of them concurrent, in separate
  transactions) left 1 row. An older observation changed nothing. `markResolved` resolves once,
  and a later `record` leaves the resolution intact.

**Review** (`/code-review`, standards and spec). No hard violations. Fixed from it:
- A missing date counted as agreement, so a dateless result could land on a re-announced sibling.
  Dates must now positively agree.
- Dropped the unused `history` mode (the PPCM backfill adds its own) and the unused
  `UNMATCHED_REASONS` export.
- The layout alarms log as `[eauction]` now.
- Small tidy-ups: one channel constant, one normalization in `lookupsFor`, and plain sequential
  lookups in `findCandidates`.

Left for later tickets, on purpose:
- **Deriving status across several links (ticket 05+).** `deriveStatus` takes many links, but the
  normalizer passes only the current observation. `tender_sources.observed_status` stores each
  source's label verbatim, so other links' labels need their own adapter's mapping first. That is
  the same answer today, because every tender has one link.
- **Reverse pointer (ticket 05).** If a gnumner discovery is ever resolved before the armeps.am
  page it points to, it creates a tender. The later armeps.am detail then has no link and no
  pointer, and would create a second one. Ticket 04's listing writes no rows, so today nothing does
  this. Ticket 05 must either resolve the armeps.am detail first, or have `lookupsFor` also ask
  "which tender points at me?".
- **Forward-only status changes e-auction behaviour in one case.** A page that went from closed
  back to active (Նախաաճուրդային → Հրապարակված) would now stay `closed`. The replay found no such
  tender. If eauction ever reopens one, `STEP` needs an exception for the open owner.

