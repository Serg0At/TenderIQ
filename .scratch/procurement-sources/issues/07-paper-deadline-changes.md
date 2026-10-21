# 07 — Paper deadline changes reach the supplier

**What to build:** When a buyer moves a paper tender's deadline, the supplier sees the new deadline
and gets an alert about the change. For paper this is the only place a change is published.
Spec: *Sources and parsers → gnumner* (amendment listing). User stories 6–7.

**Blocked by:** 06, 15, 18

**Status:** ready-for-agent

- [ ] **A changed invitation re-posted on the invitation listing is also an amendment** (decided
      2026-10-21, found in ticket 06). Example: `ԵՊՊՔ-ԳՀԱՊՁԲ-26-3` was uploaded on 10-08 and again,
      changed, on 10-12 with the same deadline, and today it is two tenders.
      - Paper has no predecessor pointer, so the rule is: a new paper invitation with the same
        normalized procedure code and the same buyer as a paper tender that is **still open**
        (alertable status, deadline ahead) joins it. Its document set change is an addendum
        (ticket 18), and a moved deadline is a field amendment.
      - Once that tender has closed or been cancelled, the same code is a new run
        (a re-announcement, ADR 0004).
      - No readable code → no join, as today.
      - Fold the existing local pair, and record how.
- [ ] The «Հրավերում կատարված փոփոխություններ» listing is swept with the same watermark rules as
      ticket 04.
- [ ] An amendment is resolved to its paper tender through the resolution module (procedure code +
      paper channel + dates). If it can't be resolved, it is an unmatched result, never a guess.
- [ ] A changed deadline raises a new `version`, sets `amended` and re-notifies through the
      existing amendment path with a change summary. `notifications_dedupe_uq` prevents
      duplicates.
- [ ] An amendment notice that moves no stored field is still an addendum (decided 2026-10-20,
      ticket 18). It raises a new version and notifies with a change summary that names the
      document, not a field, and only while the tender is open.
- [ ] Unreadable amendment files count as `unsupported_format`.
- [ ] Verified by hand on two real amendments. Record them here.
