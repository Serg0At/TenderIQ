# 05 — ARMEPS tenders appear in Discovery

**What to build:** A supplier sees ARMEPS open tenders and quotations in the tender list, labelled
`armeps`, with deadline, CPV, evaluation method, purchase kind and the documents (invitation in HY,
EN and RU, bill of quantities). Saved-search alerts and the relevance ranking pick them up exactly
as they do e-auctions. A gnumner notice and its armeps.am page are one tender. Spec: *Sources and
parsers → armeps.am*. ADR 0004 matching rule 2.

**Blocked by:** 03, 04, 14

**Status:** ready-for-agent

- [ ] An `armeps` adapter (the real armeps.am) with a client and a pure detail parser for the CfT
      page, reached by `resourceId` only. It has no listing.
- [ ] The parser yields buyer, titles in HY/EN/RU, procedure code, procedure type, evaluation
      method, purchase kind, CPV, deadlines and the document list. The `c4t_*.xml` tender
      structure yields lots.
- [ ] Each detail becomes an observation through the resolution module. The tender carries an
      `armeps` link (role `detail`) and a `gnumner` link (role `discovery`), and is never two
      records. Re-fetching changes nothing.
- [ ] `submission_channel = 'armeps'`. `procedure_type` comes from the page (open, quotation, and
      so on), never `e_auction`.
- [ ] Documents are stored and listed through `tender_documents`, from our stored copies, never
      fetched on a click.
- [ ] An amended CfT page raises a new version and re-notifies through the existing amendment
      path.
- [ ] **ARMEPS tenders are refreshed.** gnumner's notice may never change while armeps.am moves a
      deadline, so nothing would re-fetch the page. Unsettled ARMEPS tenders (not awarded or
      cancelled, within a refresh window) are re-fetched on a schedule, the counterpart of
      `tender.refresh`, with its own config knobs and a scheduler id derived from the source key.
- [ ] **The detail job id stays `armeps-detail-{resourceId}-{fingerprint}`**, as ticket 04 built
      it and as e-auction does. A changed gnumner notice must trigger a new fetch, and a
      `resourceId`-only id would be swallowed by BullMQ while the earlier job is still kept as
      completed. Duplicate fetches are cheap, because the detail handler dedupes the payload by
      hash. Refresh jobs use their own id scheme and must not collide with discovery ids.
- [ ] **No hardcoded hosts in the gnumner listing parser.** It stays pure but takes its base URL
      and the three hosts (gnumner, armeps.am, eauction) as a parameter built from the sources
      config, as eauction's `parseDetail(html, { baseUrl })` already does. Relative links resolve
      against the configured gnumner base, and `SOURCE_GNUMNER_BASE` then really changes
      classification. armeps.am's own base URL lives in its sources-config entry.
- [ ] Raw HTML is kept, and replay from storage works.
- [ ] **Before writing anything, confirm `raw/armeps/` and `tender-docs/armeps/` are empty and the
      legacy folder map is gone (ticket 14).** If either still holds e-auction objects, stop: an
      armeps.am object written there would be indistinguishable from them. Then armeps.am writes
      under its own `armeps` folders, and a reindex dry run over a mixed set maps its keys to
      `armeps` and e-auction keys to `eauction`.
- [ ] Verified by hand against three live CfT pages (including resourceId 12315509). Record the
      parsed fields next to what the page shows.
- [ ] `GET /tenders?submissionChannel=armeps` returns them, and a saved search with a matching CPV
      raises an alert.
