# 08 — Rank the tenders that carry no CPV code

**What to build:** A tender with no CPV code anywhere still gets ranked, instead of sinking to the
bottom by default.

This is a small case today and a growing one tomorrow. Of 148 biddable tenders, 147 carry a code
on at least one lot, because the invitation archive is fetched for current tenders — but the
archive behind them is far patchier, and a source that stops publishing invitation archives would
turn this edge case into the common path overnight.

The fallback is word overlap between the tender's title and lot names and the text of the tenders
this organization has bid on, **weighted by how rare each word is across the corpus**. Plain
overlap would be useless here: Armenian lot text averages 3,000 characters per tender and is full
of boilerplate — `տես կից ֆայլը` ("see attached file"), whole specification paragraphs, and
procurement phrases present in half the corpus. A word appearing everywhere must count for
nothing; `ռենտգեն` must count for a lot. Words are cut to a stem prefix so Armenian case endings
do not split one word into five.

It lives in its own module, not inside the scorer, and it ranks **below** a real CPV match: a
guess from text must never outweigh the code the invitation states outright.

**Blocked by:** 05.

**Status:** done

- [x] A biddable tender with no CPV code anywhere still receives a score and reasons rather than
      a silent zero.
- [x] Word rarity is computed from the corpus, so boilerplate contributes nothing and distinctive
      terms dominate.
- [x] Words are normalised enough that Armenian case endings do not prevent a match.
- [x] A text-based match scores below an equivalent CPV match, and its reason is distinguishable
      so a client can word it more tentatively.
- [x] The rarity logic is a separate pure module, usable and inspectable on its own.
- [x] Tenders that do have CPV codes are ranked exactly as before this ticket.
- [x] Still inside the 1.5s P95 budget — rarity data is prepared once per request at most, never
      per candidate pair.
