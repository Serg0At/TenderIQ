# 37 — Paper invitations whose deadline sentence is not read

**What to build:** The paper invitation parser reads the bid deadline in every wording of the
submission sentence that buyers use. When no deadline can be read and the listing shows no close
either, the tender does not stay biddable forever.

**Blocked by:** None.

**Status:** done

**Triaged 2026-10-29.** Decisions for the open boxes:

- **The «ուղարկվելու օրվանից» case: never count it from publication.** Nothing shows that the
  send day is on or after the publication day. If the buyer sent the invitation first,
  publication + N is later than the real deadline, and that is the unsafe error. Instead, use
  the next fact down the order below.
- **A new fallback, the stated bid opening.** The template states the opening date and time,
  and ticket 36 found it equal to the deadline every time it looked (ՊՄԱԹ-ԳՀԱՇՁԲ-26/42,
  ԱԱ-ԳՀԱՇՁԲ-26/33). The deadline is the first of these that exists:
  1. the deadline sentence;
  2. the stated bid opening;
  3. the listing's close;
  4. none.

  Adopt step 2 only if it holds on real data. Over every stored invitation that states both a
  deadline sentence and an opening, count how often the opening equals the deadline, and paste
  the count. If they disagree more than rarely, drop step 2 and record why.
- **A paper tender with no deadline does not stay biddable forever.** `refresh-gnumner` closes
  it once its newest file's publication is older than a ceiling. Take the ceiling from data:
  the longest stated N across the stored paper invitations, per procedure type, plus a margin,
  so that a live tender is never closed early. Record the values. A missed live tender costs
  more than a dead one shown too long, so choose the larger value when in doubt.
  `sources:verify` prints how many paper tenders have no deadline, and how many were closed by
  the ceiling.

Found in ticket 36's replay (local `tendra`, 2026-10-29). Four stored invitations log `states no
deadline, and the listing shows no close: stored without one`. These tenders have no
`deadline_at`, so nothing ever closes them.

| invitation | code | what the sentence says |
|---|---|---|
| `d2055d44…` | ՇՄՁԻԹՄԴ-ԳՀԱՇՁԲ-26/01 | «… հրապարակման օրվանից հաշված 7 -րդ օրը՝ 2026 թվականի սեպտեմբերի 11-ին ժամը 11։00-ն»: a day count, with the date written out in words in place of «օրվա ժամը» |
| `f711fe0c…` | ԿՀԳԿ-ԳՀԱՊՁԲ-26/15 | «… մինչև 2026 թվականի Հոկտեմբերի 16-ին ժամը 12:00-ը»: a date with the month in words |
| `a6e7e118…` | ԼՄՓՀ-ՓԿՀ-ԳՀԱՊՁԲ-26/06 | «… մինչև սույն հայտարարությունը և հրավերը հնարավոր մասնակցին ուղարկվելու օրվանից հաշված 7-րդ օրվա ժամը 12:00-ն»: counted from the day the invitation was **sent** to the supplier, not from publication |
| `bb9dec42…` | ԳԳԱԿ-ԳՀԾՁԲ-27/1/Պ | no sentence the parser recognises. Not looked at yet |

The first two are template wordings: the date is right there in the text. The third is a
different case. The send date is not on gnumner, and publication + N would be a guess.
Ticket 06 says showing a day early is the safe error, but nothing has checked that the send day
falls on or before the publication day.

## Acceptance

- [x] **Read the date in words** («2026 թվականի սեպտեմբերի 11-ին ժամը 11։00»), both after a
      day count and on its own. Check it against the stated bid-opening date, as ticket 06 did.
      *Both read, and bb9dec42's «2026թ հոկտեմբերի 21-ը» too. Each equals its stated opening:
      f711fe0c 16 Oct 12:00, bb9dec42 21 Oct 15:00; d2055d44's opening states only the hour
      («ժամը 11։00-ին»), which matches, and its date is publication (4 Sep) + 7.*
- [x] **The «ուղարկվելու օրվանից» case** takes its deadline from the stated opening, then the
      listing, then none. Never from publication + N. *Never from publication + N. The opening
      step was dropped (next box), so it is the listing, then none, then the ceiling.*
- [x] **The stated bid opening as fallback:** paste the agreement count first. *52 of 60 equal
      to the minute, 8 not, 3 of those opening after the deadline. Dropped. See* The bid opening.
- [x] **Open `bb9dec42…`** and record what its sentence says. *«… փաստաթղթային ձևով մինչև
      2026թ հոկտեմբերի 21-ը ժամը 15:00-ը»: a date in words ending «-ը», no «թվականի». Read now.*
- [x] **The ceiling close for a paper tender with no deadline**, as decided above. Today such a
      tender is `active` with no end. ԱԱ-ԳՀԱՇՁԲ-26/33 sat like that from 2026-09-04 until
      ticket 36. *Quotation 30 days, open 90, any other type 90. See* The ceiling.
- [x] **Replay with `notices:replay --kind=invitation`**, then run `sources:verify`. *See*
      Replay.
- [x] **Old and new parsers over all stored paper invitations:** identical output except the
      deadlines this ticket adds. Paste the differences, as ticket 36 did. *64 of 67 identical;
      the 3 differences are this ticket's. See* Old against new.

## Old against new (2026-10-29, local `tendra` + MinIO, all 67 stored gnumner invitation files)

Every `detail:` payload, parsed by HEAD's parser and by the new one, not counting the new
`opening` field. 63 readable both times, 4 unreadable both times (.doc, .7z with no Word file).
**64 of 67 identical.** Differences:

```
ԳԳԱԿ-ԳՀԾՁԲ-27/1/Պ     bb9dec42  deadline null → {date 2026-10-21, 15:00}
ՇՄՁԻԹՄԴ-ԳՀԱՇՁԲ-26/01  d2055d44  deadline null → {date 2026-09-11, 11:00}
ԿՀԳԿ-ԳՀԱՊՁԲ-26/15     f711fe0c  deadline null → {date 2026-10-16, 12:00}
```

a6e7e118 (and its sibling 65c7ce4d, ԼՄՓՀ-ՓԿՀ-ԳՀԱՊՁԲ-26/05, the same buyer and wording) still
read no deadline, on purpose.

## The bid opening

Over every stored invitation that states both a deadline sentence and a dated opening (60; the
count is over files, superseded ones included), opening against the deadline sentence:

- **52 equal to the minute**
- 4 the same day at another time
- 4 another day

```
0fc947c6  (Agarak, no code)    deadline 26 Oct 12:00   opening 26 Oct 17:00   opens after
7384f229  (Agarak, no code)    deadline  2 Oct 12:00   opening  2 Oct 17:00   opens after
e6d7ac9a  (Agarak, no code)    deadline 13 Oct 18:00   opening 13 Oct 17:00
ՀՀԱՄ-ԾՀԿԾՀ-ԳՀԱՊՁԲ-02/26       deadline  8 Sep 16:00   opening  8 Sep 12:00
ՍՏ-ԳՀԱՊՁԲ-26/04               deadline 13 Oct 12:00   opening 14 Oct 12:00   opens after
ՍՀՏ-ԳՀԱՊՁԲ-2026/20            deadline 19 Oct 16:00   opening 16 Oct 16:00
ԳՄՋՄԴ-ՀՄԱԱՊՁԲ-26/10           deadline 13 Oct 15:30   opening 12 Oct 15:30
ՎՁՄԳ-ԳՀԱՊՁԲ-26/3              deadline 29 Oct 11:00   opening 28 Oct 11:00   (the listing says 28 Oct 11:00)
```

**Step 2 is dropped.** 8 of 60 (13%) is more than rarely, and in 3 of the 8 the opening comes
after the deadline, which would tell a supplier a deadline up to a day late. Agarak's buyer
does this every time it states different times. So the «ուղարկվելու» files get the listing's
close, and neither of them has one.

The opening is still parsed (`invitation.parser.js#readOpening`, the `opening` field), like
`lotTable`: production does not read it, and `sources:verify` prints the agreement count, so
the decision can be checked again as files accumulate. Wordings it reads: a date in figures
(«12.10.2026թ-ին», «14.10.2026թ., ժամը՝»), in words («« 2026» « հոկտեմբերի» «26» -ին»,
«2026 թ-ի հոկտեմբերի 01-ին», misspelt «հոկտեմեբրի», «հոկտոմբորի»), a day count, «ժամը 11-ին»
with no minutes, and a month and day with no year («սույն թվականի հոկտեմբերի 15-ին», the two
«ուղարկվելու» files; «հոկտեմբերի 15-ին»). One states only the hour (d2055d44): null.

## The ceiling

The longest deadlines seen, in days from publication to the deadline:

| procedure | stated in the invitation | typed as the listing's close |
|---|---|---|
| quotation | 16 (60 files; 7 in 50 of them) | 15 (58 notices) |
| open | 41 (1 file) | 44 (40 notices) |

**`UNDATED_OPEN_DAYS` = quotation 30, open 90; any other type 90** (`observation.js`), about
twice the longest of each. The open sample from the files is one, so the listings decide that
value. A missed live tender costs more, so the margin is wide.

## Built

- **`invitation.parser.js`.** One `readWhen` reads a sentence's time: a day count, a date in
  figures, a date in words (month by its first letters, genitive «-ի» required, so the street
  «Հոկտեմբերյան 2» is never a month), and a month and day with no year (`monthDay`). `TIME`
  allows a mark after «ժամը» and no minutes. Each sentence is cut at its own full stop (`:` or
  `։` before a capital, never the colon of «11։00»), so the deadline cannot read the opening
  sentence's date that follows it. These wider spellings apply to deadlines too. The comparison
  shows they moved none, apart from the three above. A deadline sentence is refused in two cases.
  The first is «ուղարկվելու» in what its day is counted from (up to the first «օրվանից»), even
  beside «հրապարակման». cf739305's later remark about sending is not that, and the first version
  of the check wrongly dropped its deadline, which the review re-run caught. The second is a date
  with no year: none has been seen in a deadline sentence, so that path is unchecked there.
- **`observation.js#paperDeadline`** reads `monthDay` in the publication's Yerevan year. It uses
  the next year if the date is more than a month behind the publication, and gives null for
  29 February in a year without one. Only the opening uses it today, so the year rule has never
  produced a stored deadline.
- **`openUntil`** on a paper observation with no deadline is `undatedOpenUntil(publication, type)`,
  which is also what `sources:verify` prints.
  `normalizer.js` passes `deadlineAt ?? openUntil` to `deriveStatus`. `deadline_at` stays null,
  because nobody stated that date.
- **`tender.repo.js#findPaperPastDeadline`** also returns undated paper tenders whose
  publication (the newest file's) is past the ceiling. It is the SQL twin of `openUntil`, and
  `paperRefresher` passes the constant, so there is one definition. Checked: with the real
  values it returns nothing, and with a 1-day ceiling it returns ԼՄՓՀ-ՓԿՀ-ԳՀԱՊՁԲ-26/06 (and
  not with a 10-day window, so the lower bound still holds).
- **`deriveStatus`** reopens a `closed` tender only when a known deadline moved ahead. A null
  deadline used to read as "ahead", so `ResultsService.record` would have reopened a tender
  that the ceiling closed when it re-derived the status from a row with no deadline. This holds on
  every channel: no source now reopens a `closed` tender because its deadline went missing.
- **`sources:verify`** reads each current paper file once (`sourceVerification.repo.js#
  paperFileTenders`, which replaces `paperTendersWithoutLots`) for three sections: no lots (as
  before), `— paper tenders with no deadline —` (by status, `closed` = closed by the ceiling,
  each open one with its ceiling day, and `deadline read, not written` for a parser not
  replayed), and `— paper bid opening against the deadline sentence —`.

## Replay (`npm run notices:replay -- --kind=invitation`)

| tender | before | after |
|---|---|---|
| ԳԳԱԿ-ԳՀԾՁԲ-27/1/Պ | active, no deadline | closed v2, 21 Oct 15:00 |
| ԿՀԳԿ-ԳՀԱՊՁԲ-26/15 | active, no deadline | closed v2, 16 Oct 12:00 |
| ՇՄՁԻԹՄԴ-ԳՀԱՇՁԲ-26/01 | active, no deadline | closed v2, 11 Sep 11:00 |
| (no code) a8af18eb | active, no deadline | closed v2, 2 Oct 11:00 |
| ԼՄՓՀ-ՓԿՀ-ԳՀԱՊՁԲ-26/05 | active, no deadline | **closed by the ceiling** (28 Sep + 30) |
| ԼՄՓՀ-ՓԿՀ-ԳՀԱՊՁԲ-26/06 | active, no deadline | active, ceiling 7 Nov |

No notification was raised. The replay prints `linked (status unchanged)` for every file
because the label is the last normalize's, and that one only links a notice. Ticket 36's replay
printed the same label over a real change. The rows above are read from `tenders`.

`sources:verify` (current files only): no deadline **2 of 61**: active 1, closed by the
ceiling 1 (6 of 61, all active, before). Opening: 50 of 58 equal to the minute, 4 same day,
4 another day, 3 opening after.

## For the owner

- **a8af18eb was not one of the four, and both parsers read its deadline.** Its tender was
  still undated, so it was probably written by a worker that was running pre-ticket-36 code
  (ticket 36 warned about this). **Restart the worker**: the running one does not have this
  parser either.
- **ՀՀԱՄ-ԾՀԿԾՀ-ԳՀԱՊՁԲ-02/26 has a lot table and no row read** (`sources:verify`). It was
  ingested after ticket 36, so it is a new lot-table variant. It is not this ticket's work.
- **The ceiling is a guess with a wide margin.** Revisit it if `sources:verify` ever shows a
  tender closed by the ceiling that was still live.
