# 29 — An e-auction amendment is a new tid that supersedes the original

**What to build:** When a buyer amends an e-auction tender, eauction.armeps.am publishes a
**new tender with a new tid**. Its page links back to the one it replaces, and it marks the
original Փոփոխված and hides it from the listing. Tendra should recognise that link, so that the
original stops looking biddable, and so that organizations matching or tracking it are told
of the amendment. Found in ticket 27 on 2026-10-20.

**Blocked by:** None.

**Status:** done

**Triage (2026-10-21):**

1. **One tender. The replacement joins the original.** This is ADR 0004's rule 2 working as
   designed. The page points at its predecessor, and the source itself calls it an amendment.
   What separates an amendment from a re-announcement is **the pointer, not the code**: a
   replacement carrying «Աճուրդի սկզբնական հրավեր(ներ)» joins, and a same-code tender without it
   stays a new run.
   - Joining keeps the pursuit, the bid draft and the checklist on the tender the supplier is
     already working on, with nothing to move. That is the decisive argument against "two
     tenders plus a superseded-by relation".
   - **The keying concern is resolved by making readers follow the current link, not the
     creating one.** A tender's *current* e-auction link is its newest one (the replacement). The
     refresh, the document stage and the results/ledger read the current link.
     `tenders.source_id` stays the creating link, as ADR 0004 already says, until readers move
     over. For e-auction, this ticket is that move.
   - The join raises `version + 1` and the ordinary amendment, with moved fields plus the new
     archive under `documentChanges`. That reaches matching organizations and, through ticket
     28, trackers.
   - If a replacement's predecessors resolve to **two different tenders** Tendra already holds,
     record it as `ambiguous` and do not merge them.
   - **Check the six re-announced codes** from ticket 03 (`ԵՔ-ԷԱՃԱՇՁԲ-26/11` and the others):
     does either run carry the predecessor block? If yes, they were amendments, not
     re-announcements. They should then join, and ADR 0004's example needs correcting. Record
     what you find.
2. **Փոփոխված is a link status, not a tender status.** The original's link records
   `observed_status = superseded`, and a superseded link is never refreshed again. That ends the
   30-day re-read. The tender's status is derived from its current link (the replacement),
   and the tender enum gets no new value.
   - If Tendra reads Փոփոխված before the replacement has joined, the tender keeps its status
     until the replacement arrives. The sweep finds the replacement within minutes, because it
     is a new tid at the top of the listing.
   - If the original's page links **forward** to its replacement, enqueue that detail page at
     once. Check this, and record it.
3. **Do not fetch predecessors Tendra never saw.** Record each predecessor tid as a `superseded`
   link on the tender instead, with no request made. Anything that later names that tid then
   resolves to this tender by rule 1. The old run's deadline and documents are history no
   supplier acts on.

**Also:** add a short "e-auction amendments" note to ADR 0004. It covers the pointer rule, and the
current link as distinct from the creating link.

What ticket 27 measured (live site and local `tendra` database, 2026-10-20):

- The replacement's detail page has a block «Աճուրդի սկզբնական հրավեր(ներ)»: a table of code,
  publish time and a `tender_details/tid/N/` link per predecessor. Example: 48185 → 48159, same
  code `ՌՀԱԲԿ ԷԱԱՊՁԲ 27/02`, with the deadline moved from 10-26 to 10-27. Chains exist:
  46964 → 46826, 46963.
- The original's page says `Կարգավիճակ: Փոփոխված`. `detail.parser.js#STATUS` does not map
  it, so `deriveStatus` falls back to the deadline.
- The listing does not show Փոփոխված tenders, so the sweep never sees the original again.
- The replacement's archive carries `popoxutyan_pastatuxt.*`, the amendment decision. 84 of
  84 such archives belong to a replacement. 90 replacements link 113 predecessors, and none
  of the predecessors is in the local database.
- An invitation file is written once at publication and never changes (266 of 266 open
  tenders), so the document stage's addendum rule (ticket 18) cannot see this.

What happens today to an original that was ingested before its amendment:

- It stays `active` with the old deadline and old documents until that deadline passes.
- `tender.refresh` then reads Փոփոխված, degrades to `closed` (non-terminal), and re-reads it
  every hour for 30 days, about 720 wasted requests per amendment.
- Trackers get nothing. The replacement is a separate new tender, so a saved search hears of
  it as new, and the pursuit, bid draft and checklist stay on the dead original.

Questions for triage:

1. **One tender or two?** ADR 0004 says a re-announcement under the same code is a new run.
   Its rule 2 says a source that *points at* another tender joins it. Here the page points
   explicitly, and the source itself calls it an amendment. Joining makes the replacement tid a
   second `eauction` link on the original tender, with `version + 1` and the ordinary amendment
   alert (moved fields, plus `documentChanges` naming the new archive), which reaches trackers
   through ticket 28. But `tenders.source_id`, the document stage, `findNeedingRefresh` and the
   ledger/results all still key on the *creating* tid, which would be the dead one. Linking
   two tenders instead keeps that intact, but needs a "superseded by" relation and a way to
   move pursuits.
2. **What does Փոփոխված map to?** The domain enum has no "superseded". `amended` would be
   wrong: it is an alertable, biddable status. Whatever it is, it must be terminal for the
   refresh, or the 30-day re-read continues.
3. **The original is often never seen.** The replacement can be the first tid Tendra meets,
   which is every case in the local database. Then rule 2 has nothing to join, and it is just
   a tender. Should the predecessor be fetched by tid, the way a PPCM `no_candidate` repairs
   itself?

Acceptance criteria (to be sharpened at triage):

- [x] `detail.parser.js` returns the predecessor tids, ~~and a fixture of a replacement page
      covers it~~, chains included. No test runner, by decision. Verified by hand on stored and
      live pages instead (below).
- [x] Փոփոխված is settled for the refresh. Following triage 2, it is a link status, not a
      tender status: the link becomes `superseded` and the refresh skips it.
- [x] An organization tracking or matching the original hears of the amendment once, naming
      what moved.
- [ ] Verified on a live amendment observed from its original's publication onward. **Not
      done.** No worker is running a live sweep, and catching one means watching an original
      until its buyer amends it. Replayed instead on real pages, with the original's
      pre-amendment state reconstructed (below). Check it on the first live join: the
      normalizer logs `TenderAmended` for the tender, and the addendum service logs
      `a replacement joined`.

## Results (2026-10-21)

**Checked before coding, live site:**

| Code | Runs | Predecessor block? |
|---|---|---|
| ԱՄԱԿ-ԷԱՃԱՊՁԲ-26/40 | 46843 Ավարտված · 47019 Ավարտված | neither |
| ԱՄՄՀ-ԷԱՃԱՊՁԲ-26/97 | 47683 Չեղարկված · 47699 evaluation | neither |
| ԵՔ-ԷԱՃԱՇՁԲ-26/11 | 47143 Չեղարկված · 47247 Ավարտված | neither |
| ԷԲԿ-ԷԱՃԱՊՁԲ-26/51 | 46865 Չեղարկված · 46895 Ավարտված | neither |
| ՀՀԿԳՄՍՆԷԱՃԱՊՁԲ-26/161 | 46998 Ավարտված · 47091 Չկայացած | neither |
| ՀԳՊԱ-ԷԱՃԾՁԲ-26/46 | 48135 Չեղարկված · 48140 Հրապարակված | 48135 → **48118**, not its partner |

- **All six are re-announcements, not amendments.** ADR 0004's example stands. The one block
  found is a separate history: 48118 was amended into 48135, 48135 was cancelled, and the code was
  re-announced as 48140, which has no block. Under the pointer rule, 48118 and 48135 are one tender
  and 48140 is a new run.
- **No forward link.** Seven Փոփոխված originals (46826, 46963, 47128, 47184, 47283, 48118,
  48159) link to no other tid, and show no block of their own. Only the current run lists its
  predecessors, all of them: 46964 lists 46826 and 46963. So reading Փոփոխված enqueues nothing,
  and the sweep finds the replacement as a new tid.

**What was built:**

- **Parser and observation.** `detail.parser.js` returns `predecessors` (from
  «Աճուրդի սկզբնական հրավեր(ներ)») and `superseded` (Փոփոխված, deliberately absent from
  `STATUS`). The observation carries `supersedes: [{ externalId, url }]`.
- **Resolution (`resolution.service.js`).** A predecessor on one tender joins it (rule
  `supersedes`). When the predecessors are on two tenders, the replacement is created as a new
  run and the join is recorded as an `ambiguous` unmatched result naming both (follow-up,
  below). A page from a superseded run,
  whether it says Փոփոխված or its link is already marked, becomes `superseded` (link-only) when
  linked and `skip` when not. `deriveStatus({ replaces })` takes the replacement's status alone:
  a non-terminal status of the old run is dropped, and `active` becomes `amended`.
- **Links.** `tender_sources.observed_status = 'superseded'`, which no later page can
  overwrite. `saveNormalized` writes the named runs in its transaction with no request, including
  runs never fetched. A join is always `TenderAmended`, `version + 1`.
- **Current link.** `tender.repo.js#currentLink` is the one non-superseded link per source. The
  refresh, the document stage (`applyInvitationFacts` resolves the tender through the archive's
  own link and refuses a superseded one) and `documents:backfill` read it. `tenders.source_id`
  stays the creating link. The API's `sources` omits superseded runs.
- **One alert.** The join's alert waits for the replacement's archive: the document job carries
  `amendment`. The archive is compared with the tender's previous set, which is now looked up by
  tender rather than by ref, and one `TenderAmended` goes out with `changedFields` and
  `documentChanges` under `match-{id}-v{version}`. If the download is disabled, already stored,
  refused or out of attempts, the alert is raised without the file list.

**Verified by hand.** These were scratch scripts, with no test files or runner.

- The parser on stored 48185 (`['48159']`), stored 46964 (`['46826','46963']`), stored 48190
  (`[]`) and live 48159 (`superseded: true`). The publish date is unaffected by the block's own
  «Հրապարակման ժամանակ» column.
- `resolve()`/`deriveStatus()` with `node:assert`, 16 cases: join; a chain joining once; two
  tenders → ambiguous; unseen predecessor → create; same code without a block → new run;
  Փոփոխված linked → link-only; already superseded link → link-only; Փոփոխված unlinked → skip;
  rule 1 before rule 2; join `active` → `amended`; a deadline-`closed` not carried; terminal
  kept; and no change without a join.
- **End to end on a throwaway clone of `tendra`**, with local storage and Redis db 9 (both
  cleared after; 2 live archive requests):
  - 48159 was reconstructed as published, by setting its live page's status back to
    Հրապարակված. It was ingested (v1, archive 3 files), and an organization tracked it at
    `preparing`.
  - The stored 48185 page then **joined it**: v2, `amended`, deadline 10-26 → 10-27, links
    `48159: superseded` and `48185: Հրապարակված`, `source_id` still `eauction:48159`. No alert yet.
  - The document job carried the amendment. The 48185 archive was stored, and **one** job,
    `match-…-v2`, came out with `changedFields` [status, published_at, deadline_at,
    qna_deadline_at, auction_at, invitation_url] and `documentChanges`
    `{ added: [popoxutyan_pastatuxt.docx], replaced: [hraver.docx, hraver_ru.docx,
    lot_1_i_texnikakan_bnutagir.xlsx] }`.
  - The matcher: 0 saved-search matches and 1 tracker, so 1 `amendment` notification (subject
    `v2`), delivered on the `log` channel only. A retried document job added no second job,
    and a second matcher run notified nobody.
  - The real Փոփոխված 48159 page re-read: link-only, tender still v2 and `amended`.
  - 379 refresh candidates, none of them superseded.
  - 46964, already held, recorded 46826 and 46963 as superseded links. 46826's Փոփոխված page
    then resolved to it, link-only. 47128's Փոփոխված page, which no stored tender links yet,
    was skipped. 48140 stayed its own tender.
  - After the review fix: a joined tender holding only its predecessor's archive appears in
    `documents:backfill` under its current link, 48185.

**Known and accepted:**

- ~~A replacement whose predecessors are on two tenders creates nothing.~~ **Changed
  2026-10-21, by decision.** Triage's "do not merge them" meant the two tenders, not "create
  nothing". The replacement is now created as a new run, with status `active`, its own link
  current, and the two held tenders and their links untouched. The join it could not make is an
  `unmatched_results` row (`ambiguous`, both tender ids in `candidate_tender_ids`). It stays
  unresolved: a re-read of the replacement resolves by rule 1 and never marks it resolved. The
  operator alert should count it as a join to settle by hand, not as a missed tender.
  - Verified with `node:assert` on `resolve()`. Two predecessor tenders give `create` with
    `unmatched: { reason: 'ambiguous', candidateIds: [t1, t2] }`, de-duplicated. One gives a
    plain join. A later read of the replacement resolves by rule 1. All 18 cases pass.
  - A throwaway case on a clone of `tendra` (local storage, Redis db 9, both cleared; no live
    requests). 46826 and 46963 were reconstructed as published and held as two tenders, then
    the stored 46964 page arrived naming both. It became a new tender (v1, its own `Ավարտված`
    link, ledger written: 7 awards, 34 bids). One `ambiguous` row recorded both tender ids,
    with `resolved_tender_id` null. Both held tenders and their links were byte-for-byte
    unchanged. A re-read of 46964 linked by rule 1 and left the row unresolved.
- **If the original's own archive job is still queued when the replacement joins,** that job is
  refused (`superseded_link`). The replacement's archive then has no previous set, and the alert
  names moved fields without files.
- **The join's alert waits for one archive download** behind the e-auction rate limit, usually
  a minute.
- `npm run cpv:backfill` still reads the creating link's archive. It is a one-off that only
  fills a blank list, and a joined tender's list comes from the replacement's archive.
