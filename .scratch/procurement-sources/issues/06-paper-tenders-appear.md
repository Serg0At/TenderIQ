# 06 — Paper tenders appear in Discovery

**What to build:** A supplier sees paper quotations (and the rare paper open tender) in the tender
list, labelled `paper`, with buyer, subject, delivery address and a real deadline date and time, so
they never have to open a Word file and count days. A paper tender appears even when its procedure
code cannot be read. Spec: *Sources and parsers → gnumner* (paper invitation parser, unsupported
formats).

**Blocked by:** 03, 04

**Status:** ready-for-agent

- [ ] A pure paper-invitation parser reads `.docx` and `.docx` inside `.zip`. It yields procedure
      code, buyer, subject, delivery address, deadline and lots where present.
- [ ] **Before anything else, the deadline rule is checked on real cases:** "N-th day counted from
      publication, at HH:MM". Does the count include the publication day, and are the days
      calendar or working days? Record the evidence here. The deadline is computed from the
      gnumner publish datetime.
- [ ] `submission_channel = 'paper'`. The tender's links are the gnumner invitation URL, with
      roles `discovery` and `detail`.
- [ ] No readable code still creates the tender (title, buyer, dates), and also records `no_code`
      in unmatched results so it is counted.
- [ ] Any other format (`.doc`, `.rar`, `.pdf`, scans) is recorded as `unsupported_format` and
      counted. **The format check carries a comment addressed to the owner** saying these formats
      are counted on purpose and meant to become supported once the counts show which ones
      matter.
- [ ] The invitation file is stored and listed in `tender_documents`.
- [ ] Raw files are kept, replay works, and a repeat sweep writes nothing.
- [ ] Verified by hand on five live paper quotations: parsed deadline vs the document text. Record
      them here.
- [ ] `GET /tenders?submissionChannel=paper` returns them, and keyword saved searches alert on
      them.
