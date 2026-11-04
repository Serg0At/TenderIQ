# 36 — Paper invitations whose lot table is not found

**What to build:** The paper invitation parser finds the lot table in every invitation that has
one. An invitation that really has none is told apart from one whose table the parser missed.

**Blocked by:** None.

**Status:** done

Found in ticket 33. **4 of the 25 paper tenders with a detail link hold 0 lots** (local `tendra`,
2026-10-29):

- ԵՔԼ-ԳՀԾՁԲ-27/5
- ՊՄԱԹ-ԳՀԱՇՁԲ-26/42
- ՍԲԿՏ-ԳՀԱՊՁԲ-2026/7
- ՍՀՏ-ԳՀԱՊՁԲ-2026/20

Ticket 33 saw the table in two of them by eye. A tender with no lots costs real things:

- **A failure notice cannot cancel it**, because "no lots known → not cancelled yet" (ticket 09).
  ՍՀՏ-ԳՀԱՊՁԲ-2026/20 has its failure notice linked and stays `closed` for this reason alone.
- **Matching and relevance lose the lot CPV codes and names.**
- **A bid on it cannot be decided per lot.**

ՊՄԱԹ-ԳՀԱՇՁԲ-26/42 also states no deadline sentence, so the listing's close is used. That fallback
stays. Check whether the sentence is there in a wording the parser misses.

## Acceptance

- [x] **Open the 4 stored files.** Record what each holds: a table in a different layout, a table
      in an annex file of the same upload, lots described only in prose, or truly none.
      *All four hold the lot table as the first table of the Armenian invitation, the usual
      template. No annex file, no prose-only lots, none truly without. See* What the files hold.
- [x] **Read every layout that is a template variant**, with the same rule as today: a lot is
      read only when the table places it. Never invent lots from prose. *Four variants: the
      header and three budget-cell wordings. Only the table header match and the budget-cell
      check changed.*
- [x] **Run the old and new parsers over all stored paper invitations.** Every invitation that
      read before gives identical output. Paste the differences. *37 of 44 identical. Three
      that already read differ: ՄՍԱԿ-ԳՀԱՊՁԲ-26/83 gains a lot that was silently dropped,
      ԱԱ-ԳՀԱՇՁԲ-26/33 and ՀՔԼ-ԳՀԱՊՁԲ-26/17 go from 0 lots to their lots. These break the line
      as written, on purpose. See* Old against new.
- [x] **Replay with `npm run notices:replay -- --kind=invitation`.** The replay must use the
      production rules: the lots go through `AddendumService.recordDocuments`. *It did not
      before: see* Built *(the replay)*.
- [x] **Confirm the failure-notice wiring.** ՍՀՏ-ԳՀԱՊՁԲ-2026/20 turns `cancelled` if its failure
      notice covers its lots (ticket 09's "the second side decides"), and stays `closed` if it
      does not. Record which happens. *Its notice lists lot 1. The invitation has exactly
      lot 1, so it turned* `cancelled` *(v1 → v2) when the replay wrote the lot.*
- [x] **Add the count of paper tenders with 0 lots to `sources:verify`,** so that future
      template drift shows up as a number. *Now `0 of 40`. See* Built.

## What the files hold

All four have their lot table at the first table of the Armenian document, header row
«Չափաբաժ… | Չափաբաժնի անվանումը» over «համարները | գնման գինը». Every row was skipped:

| tender | why no row was read |
|---|---|
| ՊՄԱԹ-ԳՀԱՇՁԲ-26/42 | header is «Չափաբաժնի» (singular), not «Չափաբաժինների»: the table was never found |
| ԵՔԼ-ԳՀԾՁԲ-27/5 | budget cell «Մինչև 3999000» ("up to") |
| ՍԲԿՏ-ԳՀԱՊՁԲ-2026/7 | budget cell «10 000 000 (տասը միլիոն ՀՀ դրամ)», the amount repeated in words |
| ՍՀՏ-ԳՀԱՊՁԲ-2026/20 | budget cell «2 500 000 (երկու միլիոն հինգ հարյուր հազար ՀՀ դրամ)» |

Two paper tenders ingested live during the work had the same problem, with a fourth variant:
dots for thousands. ԱԱ-ԳՀԱՇՁԲ-26/33 has «7.244.340» and ՀՔԼ-ԳՀԱՊՁԲ-26/17 has «168․000»
(U+2024). The old check allowed one decimal point only. The same rule had been dropping rows
silently: ՄՍԱԿ-ԳՀԱՊՁԲ-26/83 held lots 1 and 3, and its lot 2 («4.050.000») was not read. A
failure notice naming lots 1 and 3 would have cancelled a tender with a live lot 2.

**ՊՄԱԹ's deadline sentence is there,** in two wordings the parser missed:
«…ներկայացնել հասցեով, փաստաթղթային ձևով մինչև սույն հայտարարության հրապարակման օրվան հաջորդող
օրվանից հաշված 7-րդ օրվա ժամը 11:10-ը». The address is left blank, and «օրվան» comes before
«հաջորդող». Both are now read: publication 2026-10-19 + 7 = 26 Oct 11:10, the same as the bid
opening the invitation states («2026» թ. «հոկտեմբերի» «26»-ին ժամը 11:10) and the same as the
listing's close it used before, so the stored deadline did not move. The fallback stays.

**ԱԱ-ԳՀԱՇՁԲ-26/33 had the same kind of miss:** «ներկայացնել` ՀՀ, Ք. Երևան, …», a mark after
the verb where the regex wanted a space. Its listing has no close either, so it was `active` with
no deadline from 2026-09-04. It is now `closed`, deadline 11 Sep 09:30, which is the bid opening
it states. That is outside the four tenders named here; it is the same sentence check.

## Built

- **`invitation.parser.js#readLots`** finds the table by a header starting «Չափաբաժին» (as
  before) or the cell «Չափաբաժնի» alone. «Չափաբաժնի համար» is the bid form's table and does
  not match. `isAmount` takes off a leading «Մինչև» and a trailing parenthesis, and accepts
  dots as separators. The amount itself is still not kept. Lots are still read only from table
  rows.
- **`lotTable`** on the parsed document says whether the table was found. It is what tells "no
  lot table" from "lot table, no row read". Production reads only `.lots`, so `sources:verify`
  is its one reader.
- **`SUBMISSION_RE`** allows a blank address and a mark after «ներկայացնել», but not a letter
  (so «ներկայացնելու» is still another word). **`DAY_COUNT_RE`** allows «հրապարակման օրվան
  հաջորդող օրվանից».
- **The replay.** `normalize.tender` queues the document stage only for a new file or an event,
  and a replay whose fields did not move raises none. Separately, a completed
  `gnumner-docs-…` job keeps its id for 24 h, so a re-queue would be dropped. So
  `notices:replay --kind=invitation` did not write the lots a parser fix reads. It now runs
  `handlePaperDocuments` in its own process after the normalize, with the job
  `paper.js#storedDocumentsJob` builds the way the first run did (URL = the earliest notice's,
  through the now-exported `observation.js#firstNotice`). That is `recordDocuments`, so
  `FailureService.rederive` runs on any lot written. Running the stage twice writes the same
  rows; a superseded file is `superseded_link` and writes none.
- **`sources:verify`** prints `— paper tenders with no lots —`: paper tenders made from an
  invitation file (result-only ones have none and are not counted), and for each with no lot,
  its current file re-read through the production parser: `lot table, no row read`, `no lot
  table`, `file not readable`, `no current file`, or `lots read, not written` (a parser fixed
  but not replayed). The query is `sourceVerification.repo.js#paperTendersWithoutLots`; its
  file-link test is the SQL twin of `paperNotice.service.js#isFileLink`.

## Old against new (2026-10-29, local `tendra` + MinIO, all 44 stored gnumner invitation files)

Every `detail:` and `upload:` payload, parsed by HEAD's parser and by the new one. 42 readable
both times. Identical, not counting the new `lotTable` field: **37 of 44**. Differences:

```
ՊՄԱԹ-ԳՀԱՇՁԲ-26/42   deadline null → {day 7, 11:10};  lots [] → [1 «Պատմական արձանների և հուշարձանների շինարարական աշխատանքների»]
ԵՔԼ-ԳՀԾՁԲ-27/5      lots [] → [1, 2]   (Հենասյան հիմքի վերականգնում ×2)
ՍԲԿՏ-ԳՀԱՊՁԲ-2026/7  lots [] → [1]
ՍՀՏ-ԳՀԱՊՁԲ-2026/20  lots [] → [1]
ԱԱ-ԳՀԱՇՁԲ-26/33     address null → «ՀՀ, Ք. Երևան, Հրաչյա Քոչար 5/2»; deadline null → {day 7, 09:30}; lots [] → [1]
ՀՔԼ-ԳՀԱՊՁԲ-26/17    lots [] → [1, 2]
ՄՍԱԿ-ԳՀԱՊՁԲ-26/83   lots [1, 3] → [1, 2, 3]   (2 «Սեղանի համակարգիչ՝ մոնիտորով», budget «4.050.000»)
```

`lotTable` is true on all 42. After the change, no readable invitation reads 0 lots.

## Replay (`npm run notices:replay -- --kind=invitation`)

```
42 invitation: linked (status unchanged)
2 invitation: unmatched unsupported_format
[failure] gnumner:8dcb8db1…: its lots complete the failure notices — cancelled v2
```

| tender | before | after |
|---|---|---|
| ԵՔԼ-ԳՀԾՁԲ-27/5 | closed, lots [] | closed, lots [1,2] |
| ՊՄԱԹ-ԳՀԱՇՁԲ-26/42 | closed, lots [] | closed, lots [1], deadline unchanged |
| ՍԲԿՏ-ԳՀԱՊՁԲ-2026/7 | closed, lots [] | closed, lots [1] |
| ՍՀՏ-ԳՀԱՊՁԲ-2026/20 | closed v1, lots [] | **cancelled v2**, lots [1] |
| ԱԱ-ԳՀԱՇՁԲ-26/33 | **active, no deadline**, lots [] | closed v2, deadline 2026-09-11 09:30, lots [1] |
| ՀՔԼ-ԳՀԱՊՁԲ-26/17 | closed, lots [] | closed, lots [1,2] |
| ՄՍԱԿ-ԳՀԱՊՁԲ-26/83 | closed, lots [1,3] | closed, lots [1,2,3] |

`sources:verify`: `0 of 40 paper tenders made from an invitation`. The zero-lot path was checked
by deleting two tenders' lots inside a rolled-back transaction: both were listed, ԵՊՊՔ-ԳՀԱՊՁԲ-26-3
with its current file (ce1e8c15…), not its superseded one.

## For the owner

- **The running worker still has the old parser.** It was started at 23:15 with
  `npm run worker`, before the change, and nodemon is not watching it. Until it is restarted, new
  paper invitations are read with the old rules. The replay did not depend on it: it writes the
  lots in its own process.
- **"Identical output" was broken on purpose for three invitations that already read**
  (ՄՍԱԿ-ԳՀԱՊՁԲ-26/83, ԱԱ-ԳՀԱՇՁԲ-26/33, ՀՔԼ-ԳՀԱՊՁԲ-26/17). Each gains lots or a deadline it
  was missing. None loses anything.
- **Four invitations still state a deadline in wordings not read.** Ticket 37 holds them
  (a date with the month in words; a day count from when the invitation was *sent*).

## Out of scope

- Deadline wordings other than ՊՄԱԹ's and ԱԱ's: ticket 37.
