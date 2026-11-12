# 05 — Inferred codes reach matching, filters and relevance, behind the gate

**What to build:** With the gate on, an inferred code works like a stated one everywhere
discovery asks for a code. A saved search on that code alerts, the CPV and field filters find
the tender, and relevance ranks it. Every alert, email and digest line that matched only through
an inferred code says "(inferred CPV)". Intelligence never sees inferred codes, and this ticket
proves it. With the gate off, nothing changes. See `.scratch/cpv-inference/spec.md`, *Readers
that use inferred codes* and *Alerts*, and ADR 0006.

**Blocked by:** 04 — Biddable lots get inferred codes at ingest.

**Status:** ready-for-agent

- [ ] A config flag (one config file, off by default) decides whether readers use inferred codes.
- [ ] `libs/cpv.js#tenderCodes` and its SQL twin `tender.repo.js#tenderCodesSql` include inferred
      lot codes when the flag is on, and change together.
- [ ] When the job writes inferred codes, it re-runs the match for that tender (`TenderIngested`,
      as ticket 25 does after a document set). `notifications_dedupe_uq` keeps it to one alert
      per organization and event.
- [ ] A match whose CPV reason comes only from an inferred code says so in its reasons; the
      Telegram, email and digest renderers show "(inferred CPV)". Old notifications still render.
- [ ] No intelligence query is edited: a benchmark, a buyer or supplier profile and competitor
      prices computed with inferred-coded lots present equal the same computed without them
      (checked).
- [ ] CLAUDE.md's *Current state* gains the inferred-CPV bullet (separate column, who reads it and
      who never does, classifier and refresh, the gate), and the ticket-17 bullet's "primary ∪
      `cpv_codes` ∪ lot codes" names inferred lot codes.
- [ ] Verified by hand with the flag on: a saved search on a code inferred for a biddable paper
      lot raises exactly one alert, marked "(inferred CPV)"; the field filter finds the tender;
      with the flag off, neither happens.
- [ ] End the report by telling the owner to restart the API and the worker.
