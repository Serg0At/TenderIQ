# 07 — Paper deadline changes reach the supplier

**What to build:** When a buyer moves a paper tender's deadline, the supplier sees the new deadline
and gets an alert about the change. For paper this is the only place a change is published.
Spec: *Sources and parsers → gnumner* (amendment listing). User stories 6–7.

**Blocked by:** 06

**Status:** ready-for-agent

- [ ] The «Հրավերում կատարված փոփոխություններ» listing is swept with the same watermark rules as
      ticket 04.
- [ ] An amendment is resolved to its paper tender through the resolution module (procedure code +
      paper channel + dates). If it can't be resolved, it is an unmatched result, never a guess.
- [ ] A changed deadline raises a new `version`, sets `amended` and re-notifies through the
      existing amendment path with a change summary. `notifications_dedupe_uq` prevents
      duplicates.
- [ ] An amendment that changes nothing Tendra stores writes no version.
- [ ] Unreadable amendment files count as `unsupported_format`.
- [ ] Verified by hand on two real amendments. Record them here.
