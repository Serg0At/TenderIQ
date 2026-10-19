# 09 — Failed procedures cancel ARMEPS and paper tenders

**What to build:** A supplier never sees a dead ARMEPS or paper tender as open. When gnumner
publishes a failed-procedure notice, the tender becomes `cancelled`. ADR 0004 status table.

**Blocked by:** 05, 06

**Status:** ready-for-agent

- [ ] The «Չկայացած գնման ընթացակարգի մասին հայտարարություն» listing is swept with watermark
      rules.
- [ ] Each notice resolves to an ARMEPS or paper tender through the resolution module, and its
      link records `observed_status = cancelled`. e-auction notices are ignored (eauction owns that
      status).
- [ ] *Derive status* sets `cancelled`. It never moves a tender back from `awarded`.
- [ ] Partially failed procedures (some lots failed) do not cancel the whole tender. Record how
      the notice shows lot-level failure, and what is stored.
- [ ] Unresolvable notices are unmatched results, and unreadable files count as
      `unsupported_format`.
- [ ] Verified by hand on three real notices. Record them here.
