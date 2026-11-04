# 26 — One "covers" rule for alerts and the CPV filter, and a division covers only itself

**What to build:** A supplier who filters Discovery by a CPV code sees exactly the tenders a saved
search on that code would alert on. A code at division level (for example `30000000`) covers its
own division and not its neighbours. Decided 2026-10-20, while Tendra has no frontend and no paying
customer, which is the cheapest moment a response can change.

**Blocked by:** None — ticket 17 is done.

**Status:** done

Two defects, one rule:

- **The filter and the alert disagree.** `filter[cpv]` is an exact-code test (ticket 17 kept it
  that way on purpose), while the matcher uses `libs/cpv.js#covers`, which is hierarchical. A
  saved search on `30000000` alerts on a tender that `filter[cpv]=30000000` does not return.
- **`significantPrefix` over-covers at division level.** It strips every trailing zero, so
  `30000000` becomes `3` and covers divisions 30–39 (office machinery *and* electrical machinery,
  …). CLAUDE.md records this as known and kept because fixing it changes which alerts fire. With
  no customers yet, that change is the point: today it sends false alerts.

Acceptance criteria:

- [x] `significantPrefix` never goes shorter than a division (2 digits). `30000000` → `30`,
      `33100000` → `331`, `03000000` → `03`. `covers` is otherwise unchanged.
- [x] `filter[cpv]` uses `covers` over the tender's codes (primary ∪ `cpv_codes` ∪ lot codes,
      ticket 17's list), through the SQL twin, which must agree with the JS rule on every stored
      code. Use the same kind of check ticket 03 did for `codeKeySql`.
- [x] The field filter (`libs/fields.js` prefixes) uses the same rule, if it does not already.
      Record which.
- [x] Relevance's `closeness` (exact / group / division) is untouched. It answers a different
      question.
- [x] Measured before and after on the local DB, and recorded here: for every saved search, and for
      the division codes `30000000` and `45000000`, the number of tenders matched by the alert rule
      and by the filter. After the fix the two numbers are equal for each code, and the division
      counts shrink by exactly the neighbouring divisions.
- [x] No alert is sent by this change. It alters future matches only. No re-match of existing
      tenders.
- [x] CLAUDE.md's "One CPV rule, two questions" paragraph is rewritten: the quirk is gone, and the
      filter and the matcher share `covers`. `docs/API_REFERENCE.md` says `filter[cpv]` is
      hierarchical.

## What was built — 2026-10-20

- `libs/cpv.js#significantPrefix` strips trailing zeros but never below two digits: `30000000` →
  `30`, `33100000` → `331`, `03000000` → `03`. `covers` itself is untouched.
- `tender.repo.js#coversAnySql` is the SQL twin of `covers` over `tenderCodesSql` (primary ∪
  `cpv_codes` ∪ lot codes): any stated code `starts_with` one of the bound prefixes. A code
  covers exactly the codes that start with its significant prefix, so `filter[cpv]` binds
  `significantPrefix` of each wanted code. `starts_with` rather than `like`, so a `%` or `_` in a
  filter value is not a wildcard (it was not one before either: the old filter was `&&`).
- **The field filter already used the right rule, through a different query.** It matched
  `like 'prefix%'`, which is `covers` under the fixed `significantPrefix`. Under the old one it
  was not: the `60`, `80` and `90` fields were narrower than a saved search on `60000000`. It now
  goes through `coversAnySql` too, and `libs/fields.js` refuses to load a prefix that is not the
  significant prefix of its padded code. For example, `3010` would match class 3010, while
  `30100000` covers all of group 301.
- `/tenders/relevant` shares `applyDiscoveryFilters`, so its `filter[cpv]` is hierarchical too.
- **`closeness` is untouched, and relevance does not move.** `relevance.service.js` calls
  `covers` only on a pair that `bestCpvMatch` already found in one division. The old and new
  rules differ only across divisions.
- **The intelligence `cpv_family` tier shares `significantPrefix`** (`benchmark.repo.js`
  `statsFor`/`comparableAwards`, `publicBid.repo.js#expectedCompetition`). So a family benchmark
  for a bare x0 division code now stays inside that division. No stored figure moves: no stored
  code (tender or lot) is a bare `x0000000`, and none of the 137 `price_benchmarks` rows is
  keyed on one. A caller-supplied code does move: `GET /competition?filter[cpv]=30000000` and
  `GET /benchmarks/30000000` now read division 30 as the family, not 30–39. The `/competition`
  docs say so.
- A one-character code (`filter[cpv]=3`, or a saved search on `3`) is shorter than a division,
  so it still covers all of 3x, on both sides alike. CPV has no such code, and Joi does not
  insist on eight digits.
- No alert is sent and no tender is re-matched. Nothing queued, nothing replayed; the rule
  applies from the next match job on.
- No test runner exists (CLAUDE.md), so the checks below are the verification, as for tickets 03
  and 25.
- Review (`/code-review`, standards and spec): no defects. Fixed from it:
  - a stale comment on `tenderCodesSql` that still named `&&` and `like any`;
  - "must move together" for `covers` ↔ `coversAnySql`;
  - one copy of the twin explanation instead of three;
  - the `/competition` `cpv_family` note.

## Verification — 2026-10-20

Against the local database `tendra`: 1206 tenders, all `is_latest` and all with a buyer.
**There are no saved searches locally**, so the "every saved search" rows are empty. Measured
instead: the two named divisions, every other division ending in 0 (the only codes whose alert
behaviour changes), and one group code as a control. The CPV clause only. A saved search's
keywords, region and value range are separate rules. No status filter on either side.

"Alert rule" is `matcher.service.js#scoreMatch` with `{ cpvCodes: [code], keywords: [] }`, run
over every tender. "Filter" is `TenderRepository.search({ cpvCodes: [code] })`, unpaged. "Expected
shrink" is computed in plain SQL, independently of `libs/cpv.js`: the tenders that state a code in
a neighbouring division (same first digit) and none in the division itself.

| code | alert, before | filter, before | alert, after | filter, after | expected shrink | alert shrink |
|---|---|---|---|---|---|---|
| `30000000` | 730 | 0 | 182 | 182 | 548 | 548 |
| `45000000` | 8 | 0 | 8 | 8 | 0 | 0 |
| `50000000` | 11 | 0 | 7 | 7 | 4 | 4 |
| `60000000` | 24 | 0 | 11 | 11 | 13 | 13 |
| `70000000` | 86 | 0 | 0 | 0 | 86 | 86 |
| `80000000` | 5 | 0 | 0 | 0 | 5 | 5 |
| `90000000` | 35 | 0 | 11 | 11 | 24 | 24 |
| `33100000` (group, control) | 171 | 0 | 171 | 171 | — | 0 |

- Before the fix, the filter returned 0 for every one of these: no tender states a bare division
  or group code verbatim, and the filter was an exact test.
- After the fix, the alert and the filter agree on every code. Each division shrinks by exactly
  its neighbouring divisions. `45000000` does not shrink, because its prefix was already `45`.
  Division 70 does not exist in CPV, so the 86 it alerted on were all 7x.

**The SQL twin agrees with the JS rule on every stored code** (the same kind of check as ticket
03's `codeKeySql`). The wanted codes were the 1825 distinct stored codes plus their 2-, 3-, 4- and
5-digit roll-ups, every division `00`–`99`, and odd filter inputs (`3`, `%`, `3_`, `30%`). That is
2709 codes. For each one, the tender set from `TenderRepository.search({ cpvCodes: [w] })` equals
the set of tenders where some stated code `c` has `covers(w, c)`: **0 mismatches**. A three-code
filter (`30000000`, `45000000`, `33100000`, any of them) also matches. All 16 fields agree as
well: `search({ cpvPrefixes })` equals `covers` over the field's padded prefixes, **0
mismatches**.
