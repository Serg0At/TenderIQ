# 05 — ARMEPS tenders appear in Discovery

**What to build:** A supplier sees ARMEPS open tenders and quotations in the tender list, labelled
`armeps`, with deadline, CPV, evaluation method, purchase kind and the documents (invitation in HY,
EN and RU, bill of quantities). Saved-search alerts and the relevance ranking pick them up exactly
as they do e-auctions. A gnumner notice and its armeps.am page are one tender. Spec: *Sources and
parsers → armeps.am*. ADR 0004 matching rule 2.

**Blocked by:** 03, 04

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
- [ ] Raw HTML is kept, and replay from storage works.
- [ ] Verified by hand against three live CfT pages (including resourceId 12315509). Record the
      parsed fields next to what the page shows.
- [ ] `GET /tenders?submissionChannel=armeps` returns them, and a saved search with a matching CPV
      raises an alert.
