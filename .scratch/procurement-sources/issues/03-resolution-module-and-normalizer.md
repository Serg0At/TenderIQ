# 03 — One resolution module; the normalizer stops being e-auction-specific

**What to build:** All of ADR 0004's merge logic lives in one pure module, and e-auction ingestion
runs through it with no visible change. After this, adding a source means writing a parser that
emits an observation, never touching merge rules. Unresolvable results are kept as unmatched
results. Spec: *One pure resolution module: the seam*.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] **Resolve:** a pure function (no Knex, no clock, no HTTP) takes one observation (source,
      external id, an optional pointer to another source's id, procedure code, submission channel,
      procedure type, buyer, dates, lot numbers) plus candidate tenders, and returns one of: link
      to an existing tender, create a new tender, or unmatched with a reason.
- [ ] Matching order is ADR 0004's:
  - an existing `(source, external_id)` link;
  - then a pointer the source carries;
  - then normalized procedure code + submission channel + dates and lots.

  Two or more surviving candidates is `ambiguous`, never a pick. A result source never gets
  "create" in live mode.
- [ ] **Derive status:** a pure function takes the submission channel, the links' observed
      statuses and `now`, and returns one `tenders.status`. Status only moves forward, and only
      the owning source per channel (ADR 0004 table) decides awarded and cancelled.
- [ ] **Normalize code:** strips «» and quotes, maps en and em dashes to `-`, collapses inner
      whitespace and uppercases. `ՍԱՊ–ԳՀԱՊՁԲ-26/18` and `«ՍԱՊ-ԳՀԱՊՁԲ-26/18»` normalize equal.
- [ ] `unmatched_results` exists (source, external ref, procedure code, reason
      `no_candidate | ambiguous | no_code | unsupported_format`, candidate tender ids, payload hash,
      first and last seen, resolved tender, resolved at) and is unique on
      `(source, external_ref)`. A repository records and re-sees rows idempotently.
- [ ] The normalize worker is a thin orchestrator (parsed observation → resolve → repositories),
      with no e-auction mapping inside it. The e-auction mapping moves next to its parser.
- [ ] `npm run normalize:replay` over every stored e-auction payload changes nothing: same
      tenders, statuses, versions, lots, ledger rows and awards. Record the before and after
      counts in this ticket.
- [ ] The six re-announced codes in the local DB (for example `ԵՔ-ԷԱՃԱՇՁԲ-26/11`) are still two
      tenders each.
