# 12 — Find tenders Tendra missed, through PPCM

**What to build:** Tendra notices when it missed a tender: PPCM reports a result that Tendra has no
tender for. Where it can, Tendra repairs the gap itself by fetching the armeps.am page. Everything
else is a counted `no_candidate` unmatched result, stored in the shape a future production operator
alert will read. ADR 0004: *a `no_candidate` result means Tendra missed a tender*.

**Blocked by:** 10

**Status:** ready-for-agent

- [ ] A periodic sweep reads the organized procedures report by a recent date window, per
      procedure form, and resolves every row.
- [ ] A row with no candidate is recorded as `no_candidate`. A re-seen row updates `last_seen`
      rather than duplicating.
- [ ] If PPCM's bid-report supplies the `resourceId`, the armeps.am detail is enqueued (ticket 05's
      job), and once the tender exists the result re-resolves and attaches.
- [ ] When bid-report is unavailable (it answered `status 500` to everything on 2026-10-18), the
      row stays `no_candidate` and counted. The sweep does not fail.
- [ ] Whenever a tender is created or linked, unresolved unmatched results whose code matches are
      re-resolved, and attach when exactly one candidate fits. `resolved_tender_id` and
      `resolved_at` are set.
- [ ] e-auction rows with no candidate are recorded, with no self-repair (no code → tid mapping).
- [ ] No operator alert is sent. That is a later, production-only feature (spec *Out of Scope*).
- [ ] Verified on the local DB: the sweep's `no_candidate` count, and at least one self-repaired
      ARMEPS tender if bid-report is up. Record both.
