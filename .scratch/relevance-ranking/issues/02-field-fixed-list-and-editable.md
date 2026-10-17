# 02 — Field: a fixed list, up to three, and changeable after sign-up

**What to build:** An organization says what industry it works in, by choosing from a list rather
than typing. A supplier that sells office equipment and furniture claims both. An owner who chose
wrongly at sign-up can change it, which is impossible today — `organizations.type` is write-once
free text set only when the organization is created, and nothing in the product reads it.

Field is the one signal a brand-new organization can give before it has any history, so it has to
be a value the system can match against tenders: each field names the CPV divisions (or 3-digit
groups, where a division would otherwise belong to two fields) that belong to it. That mapping is
one constant in code, and it is the same constant the relevance ranking and the field filter both
read — two answers to "what counts as medical" is exactly the kind of drift this codebase avoids
elsewhere.

The draft list is in the spec. Treat it as a starting point to be sanity-checked against the CPV
divisions actually present in the corpus, not as settled.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] A single constant defines every field, its stable identifier, and the CPV divisions or
      groups it covers. Nothing else in the codebase hard-codes a field.
- [ ] An organization holds up to three fields, chosen from that list; claiming a value outside
      it, or a fourth, is a validation failure.
- [ ] Fields stay optional: creating an organization without them still works, and sign-up is not
      given a new required step.
- [ ] An owner or admin can change their organization's fields after creation, and the change is
      visible immediately on reading the organization back.
- [ ] Changing fields is gated on the permission that governs organization settings, and is
      refused across tenant boundaries like every other private write.
- [ ] The live database is migrated with an additive, twice-safe script; the full-schema migration
      is updated to match so a fresh database comes out the same shape; the script is deleted once
      applied, per the four-step workflow in CLAUDE.md.
- [ ] `CONTEXT.md`'s definition of **Field** still matches what was built.
- [ ] `docs/API_REFERENCE.md` documents reading and changing an organization's fields.
