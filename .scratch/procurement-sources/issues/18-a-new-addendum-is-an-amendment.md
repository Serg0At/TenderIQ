# 18 — A new addendum is an amendment

**What to build:** When a buyer adds a document to an open tender (an addendum), suppliers who
matched or track that tender are told, even if no field Tendra stores moved. Decided 2026-10-20: an
addendum usually changes requirements, and a supplier preparing a bid against the old documents
loses the bid. Found in ticket 05: today a new addendum stores a new archive but raises no version
and sends nothing.

**Blocked by:** None — can start immediately (ticket 05 is done).

**Status:** ready-for-agent

- [ ] For ARMEPS, a change in the buyer's document set (`documents.js#documentSetHash`: path, CRC
      and size of the buyer's files, never the archive bytes, which change on every download) is
      part of what counts as an amendment. It raises a new `version`, sets `amended` while the
      tender is open, and re-notifies through the existing amendment path.
- [ ] The change summary names what changed ("new document: <file name>"), and the alert says so.
      It never claims a field changed when none did.
- [ ] No notification for an addendum on a tender that is past deadline, awarded or cancelled.
      Its version is still recorded, so history is complete.
- [ ] `notifications_dedupe_uq` still prevents a duplicate for one event, while a second addendum
      on the same tender is a new event. Record how the existing amendment path keys this.
- [ ] **e-auction: measure before switching it on.** Ticket 14 found 396 stored invitation archives
      that are older content hashes of a re-issued invitation. Compare their file sets (path, CRC,
      size). Count how many re-issues changed the buyer's files and how many changed only bytes.
      Apply the rule to e-auction only on the file-set identity, and record the counts here. If
      e-auction's archive needs its own set-hash builder, add it beside its parser.
- [ ] Paper follows the same rule through ticket 07: an amendment notice is itself an addendum.
- [ ] A replay from storage raises no notification for an addendum that was already processed.
- [ ] Verified by hand on one real ARMEPS addendum: version, change summary and one alert job.
      Record it here.
