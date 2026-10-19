# 02 — Source links and submission channel on every tender

**What to build:** Every tender knows its **submission channel** and every **source** it came from.
A supplier sees both in the API and can filter the list by submission channel. Today every tender is
`eauction` with one link, but the shape is ready for the other channels. Spec: *Schema*, *API*.
ADR 0004.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] `tenders.submission_channel` is NOT NULL and constrained to `eauction | armeps | paper` at
      the DB level. Existing rows are backfilled to `eauction`.
- [ ] `tender_sources` exists: tender (cascade), source, external id, URL, role
      (`discovery | detail | results`), observed status, first and last seen, with
      `UNIQUE (source, external_id)`.
- [ ] Every existing tender has exactly one `eauction` link (external id = tid). e-auction
      ingestion writes and refreshes that link on every detail fetch.
- [ ] A concurrent insert that loses the unique race is treated as success, as it is for
      `source_payloads`.
- [ ] Tender list and detail responses carry `submissionChannel`. Detail also carries the source
      links (source, URL, role).
- [ ] `GET /tenders` and `GET /tenders/relevant` accept a `submissionChannel` filter (one or more
      values), validated by Joi. An unknown value is `VALIDATION_FAILED`.
- [ ] `docs/API_REFERENCE.md` documents the field and the filter.
- [ ] The schema change follows the four-step workflow, and `create_table.js` and `drop_table.js`
      both carry it.
