# 29 — An e-auction amendment is a new tid that supersedes the original

**What to build:** When a buyer amends an e-auction tender, eauction.armeps.am publishes a
**new tender with a new tid**. Its page links back to the one it replaces, and it marks the
original Փոփոխված and hides it from the listing. Tendra should recognise that link, so that the
original stops looking biddable, and so that organizations matching or tracking it are told
of the amendment. Found in ticket 27 on 2026-10-20.

**Blocked by:** None.

**Status:** needs-triage

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

- [ ] `detail.parser.js` returns the predecessor tids, and a fixture of a replacement page
      covers it, chains included.
- [ ] Փոփոխված maps to a status the refresh treats as settled.
- [ ] An organization tracking or matching the original hears of the amendment once, naming
      what moved.
- [ ] Verified on a live amendment observed from its original's publication onward.
