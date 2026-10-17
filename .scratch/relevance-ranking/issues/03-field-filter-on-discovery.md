# 03 — Filter Discovery by field

**What to build:** A supplier narrows Discovery to their industry in one click, without knowing a
single CPV code. Choosing "Medical & pharmaceutical" returns the tenders whose codes fall under
that field, whether the code sits on the tender itself or on one of its lots.

This is what makes the field worth collecting for someone who has no history yet, and it is half
of the answer the relevant list gives when it has nothing to rank on: "we cannot rank for you yet,
but you can narrow by field and purchase kind".

Matching a field means resolving it, through the constant from ticket 02, into the CPV divisions
and groups it covers, then matching by prefix — a field naming division 33 must match 33141110 on
lot 7 of 18. Discovery's existing CPV filter already searches headline code and lots together for
exactly that reason; this must not be a second, narrower answer.

**Blocked by:** 02 — the field list and its CPV mapping.

**Status:** done

- [x] The tender list accepts a field filter and returns tenders whose headline code or any lot
      code falls under that field.
- [x] An unknown field is a validation failure, not an empty result.
- [x] A tender whose only matching code sits on a lot is returned — verified against a real
      multi-lot tender in the live database.
- [x] The filter composes with every existing Discovery filter and with cursor paging.
- [x] Tenders with no CPV code anywhere are absent from a field-filtered result, and that is
      understood and accepted rather than papered over with a text guess.
- [x] `docs/API_REFERENCE.md` documents the filter.
