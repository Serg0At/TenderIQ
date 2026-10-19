# 01 — Rename the source key `armeps` to `eauction`

**What to build:** The e-auction source is called `eauction` everywhere it appears as data or
configuration, so that `armeps` can later mean armeps.am without one name meaning two websites.
Ingestion, replay and every reader behave exactly as before. Spec: *The rename comes first*. ADR 0004.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Data is renamed through an additive, run-twice-safe script, following the four-step schema
      workflow in CLAUDE.md. That covers the `tenders.source_id` prefixes, `source_payloads.source`,
      the `parties.source_id` prefixes, and the `source` values and column defaults in `awards`,
      `public_tender_bids` and the other ledger tables.
- [ ] `create_table.js` carries the new defaults, and the script is deleted once applied.
- [ ] The sources config key, the adapter folder, the Redis sweep, watermark and freshness keys,
      and every code literal use `eauction`. Existing Redis watermarks carry over, so the next sweep
      does not cold-start.
- [ ] Stored objects are not moved. `source_payloads` still points at the existing storage keys,
      and new payloads are written under the new prefix.
- [ ] `npm run normalize:replay` on the local DB produces no changes to any tender, ledger row or
      award.
- [ ] A live sweep after the rename writes 0 rows and enqueues 0 jobs for unchanged tenders.
- [ ] No reference to the old key remains outside git history and this ticket. Check with grep.
- [ ] CLAUDE.md and docs/SCRAPER_WORKFLOW.md name the source `eauction`.
