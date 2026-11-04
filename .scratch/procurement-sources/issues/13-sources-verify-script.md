# 13 — `sources:verify`: check the merge rules on real data

**What to build:** The operator runs one command and sees, per source, how many results attached
and how many did not, by reason, plus the PPCM-vs-ledger comparison. This is the stand-in for a test
suite: it prints numbers and asserts nothing. Spec: *Verification script*, *Testing Decisions*.

**Blocked by:** 08, 10

**Status:** done

- [x] `npm run sources:verify`, with a description entry in `package.json` like
      `relevance:backtest`, and `--from` / `--to` options for the window.
- [x] Per source (`eauction`, `armeps`, `gnumner`, `ppcm`): tenders created and linked, and
      unmatched results by reason (`no_candidate`, `ambiguous`, `no_code`, `unsupported_format`),
      with `unsupported_format` broken down by file extension.
- [x] Tenders per submission channel and status.
- [x] The PPCM-vs-ledger comparison on e-auction tenders present in both: rows equal on net price,
      contract price equal to gross award, rejection-flag disagreements, and parties that gained a
      ՀՎՀՀ.
- [x] gnumner's e-auction notices counted against e-auction tenders held, as an independent
      coverage check. The count is built, but it reads 0 until gnumner's e-auction listing is
      swept and indexed (*For the owner*).
- [x] It reads through repositories only. No Knex in the script.
- [x] Run once on the local DB, with the output pasted here. The `unsupported_format` breakdown
      is what decides whether a `.doc` / `.rar` converter is worth adding, so raise that with the
      owner.

## Built

- `src/scripts/verifySources.js` (`npm run sources:verify`). Its counts come from a new read
  model, `repositories/sourceVerification.repo.js`. Like `relevance.repo.js` for the backtest,
  it holds only aggregates. The script itself holds no Knex.
- **The window is over first seen**, not over when a source published: `[--from, --to)` on
  `first_seen_at`, and on `fetched_at` for PPCM answers. A tender is in the window when its
  creating link is. That link is the one whose `{source}:{external_id}` is `tenders.source_id`,
  and all 1,228 local tenders have it. A bare date is midnight UTC. Leave both out for
  everything.
- **The PPCM comparison replays the production rules.** Every stored PPCM answer (`results:`
  by code, `sweep:` by day) goes through `observeProcedures` / `observeDay`, `resolve` and
  `matchTaxIds`, and is compared with `ledgerForTender`, `awardsForTender` and
  `netOffersForTender`. When several answers hold one procedure, the newest is kept. The
  rejected flag is read off the raw rows, because the observation deliberately does not read
  it. Nothing is written, and the run takes about 3 s locally.
- **Net price is checked against the bidder's own bid.** That bid is found through the ՀՎՀՀ its
  party holds. A bidder whose party holds none can be placed only by lot and net, which is the
  ՀՎՀՀ join itself, so it is counted apart rather than called equal.
- **A contract is "off by rounding"** within 2 AMD or 0.1%. Otherwise it is below or above the
  gross award.
- **The ՀՎՀՀ held count is all time.** Nothing records when a party gained its ՀՎՀՀ, so "gained in
  the window" cannot be answered.
- **`unsupported_format` by notice kind** is the owner's query from `invitation.parser.js`. It
  uses a left join, so a row whose payload row is gone would still count, as `none`.

## Verification (2026-10-28, local Postgres `tendra`, MinIO)

`npm run sources:verify`, everything:

```
window […, …) over first seen

— per source —
  eauction: created 1152 tenders, linked to 1152 (links: 1265 detail)
  armeps: created 55 tenders, linked to 55 (links: 55 detail)
  gnumner: created 21 tenders, linked to 74 (links: 22 detail, 81 discovery, 5 results)
    unmatched no_candidate          31 open (1 public, 30 unknown), 4 since taken by a tender
    unmatched no_code                4 open (1 never public, 3 unknown)
    unmatched unsupported_format    42 open (11 never public, 1 public, 30 unknown), 1 since taken by a tender
    missed tenders (no_candidate, public): 1
  ppcm: created 0 tenders, linked to 2 (links: 2 results)
    unmatched no_candidate         688 open (563 public, 125 unknown), 1 since taken by a tender
    missed tenders (no_candidate, public): 563

— unsupported_format, open, by notice kind × procedure × extension —
  contract (18)
    competitive      6: doc 4, docx 1, pdf 1
    single_source   11: doc 4, pdf 4, rar 2, zip 1
    unknown          1: rar 1
  failed (18)
    competitive     17: rar 7, doc 4, zip 4, bin 1, pdf 1
    unknown          1: doc 1
  invitation (6)
    competitive      1: rar 1
    unknown          5: 7z 2, zip 2, rar 1
  by extension (not single-source / all): doc 9/13, rar 10/12, zip 6/7, pdf 2/6, 7z 2/2, docx 1/1, bin 1/1

— tenders by submission channel × status —
  armeps       55: active 25, amended 1, awarded 2, closed 27
  eauction   1152: active 267, awarded 332, cancelled 186, closed 367
  paper        21: active 1, awarded 2, cancelled 2, closed 16

— gnumner e-auction notices against e-auction tenders held —
  0 notices: 0 held, 0 not held, 0 with no code (cannot be checked)

— PPCM against the e-auction ledger —
  492 stored answers, 323 e-auction procedures: 217 link, 106 unmatched no_candidate
  217 e-auction tenders in both
  net price, bidder's own bid:      3430 of 3436 equal (6 bidders not placed by ՀՎՀՀ: 5 with a bid at that lot and net, 1 without)
  contract price = gross award:     868 of 994 (120 off by rounding — 2 AMD or 0.1% —, 5 below it, 1 above it; 1 lots with no award of ours)
  rejection flag:                   306 agree, 279 disagree (2848 rows PPCM leaves blank, 9 not joined to one bid)
  ՀՎՀՀ join: 3385 bidder rows matched (3385 already held, 0 parties still blank); not matched: 48 ambiguous, 6 no_bid, 3 several_bids
  e-auction bidders holding a ՀՎՀՀ: 344 of 754 (all time — nothing records when one was gained — every one from PPCM); 2 of them shared with another party
```

A window of `--from=2026-10-25 --to=2026-10-28` gives:

- 1 ARMEPS tender created;
- the PPCM no-candidate rows, since the sweep recorded them that week;
- no unreadable files and no gnumner rows.

`--from=garbage` is refused with a message.

### Reading it

- **Net price.** 3,430 of 3,436 PPCM bidders placed by ՀՎՀՀ offer exactly their own ledger bid
  (research.md: 95 of 95). The 6 that do not:
  - 3 are PPCM rounding to whole AMD: 14,583,334 against 14,583,333.34, 156,667 against
    156,666.67, and 47,999,979 against 47,999,978.
  - 2 are junk offers. ՀՀԱՄՎՀ-ԷԱՃԱՊՁԲ-26/08 has 5.6·10¹⁶ in PPCM. ՀՀ ԱԺ ԷԱՃԱՊՁԲ-26/19 lot 3 has
    5·10¹¹ in PPCM against 5,111,111,111.
  - 1 is a different offer: ԿՄՀՔ-ԷԱՃԱՊՁԲ-26/88 has 5,832,700 against 200,000,005.

  Six more bidders cannot be placed by ՀՎՀՀ. Caveat: a party's ՀՎՀՀ came from a lot-and-net match
  (ticket 11), so this figure is independent only on the bidder's other lots.
- **Contract against gross award.** 868 of 994 are exact, and 120 are off by rounding (research.md
  saw one off by 1.50 AMD). The other 6:
  - 3 small lots are off by 16–60 AMD (0.13–0.21%): VAT rounded per item.
  - 2 are smaller contracts: ՀԱԱՀ-ԷԱՃԱՊՁԲ-26/102 is −2.3% and ԵԱ-ԷԱՃԱՊՁԲ-26/49 is −9.1%. That is
    ticket 10's framework or partial-funds case, much rarer on e-auctions than its "1 lot in 7".
  - 1 is 60× the award: ՀՀՏՄ-ԷԱՃԾՁԲ-26/02 has 8,640,000 against 144,000. It looks like a unit
    price against a total for 60 units. It was not checked against the page.

  None of this touches stored data, since PPCM writes no award for an e-auction.
- **The rejection flag is worthless, as decided.** It disagrees with the ledger on 279 of the 585
  rows where it is set, and 2,848 rows leave it blank. That confirms "`bid_rejected` is not read".
- **Ticket 11 is complete locally.** Every PPCM bidder that can be matched already holds its
  ՀՎՀՀ, and 0 parties are still blank. 344 of 754 e-auction bidders hold one.
  - 2 of those ՀՎՀՀ are also held by a buyer party (05804656, 04418902). That is a supplier
    and a buyer sharing a number: reported, never merged, by design.
  - Every other party with a shared ՀՎՀՀ is a buyer pair, Yerevan State University and its
    branch (ticket 19's name veto). No two bidders share one.
- **The 563 "missed" PPCM procedures are ticket 12's first 90-day sweep:**
  - 76 open and 487 quotation, all ARMEPS-form.
  - That run predates the operator alert, which pages only on misses first seen after it is
    switched on.
  - The 106 e-auction no-candidates are `was_public` null, as decided: there is no e-auction
    floor yet.
- **gnumner's e-auction notices: 0.** That is a gap in what is swept, not a result (*For the
  owner*).

### `unsupported_format`: is a converter worth it? (raised with the owner 2026-10-28)

Each of the 42 open rows was pulled from MinIO and opened by hand: magic bytes, zip and RAR
entry names, and `pdftotext`. The extension the counts show is not always the format:

| file | n | what it really is | needs |
|---|---|---|---|
| `.doc` | 13 | Word 97–2003 (OLE2) | LibreOffice. `antiword` reads the Armenian, tables as pipe text, but that would need a second table parser |
| `.rar` | 12 | 8 hold a `.docx` only; 3 an Armenian `.doc` beside a Russian `.docx`; 1 a PDF | unrar (8); unrar + LibreOffice (3) |
| `.zip` | 7 | 2 invitations with the Armenian file in a nested `.rar`; 2 a `.doc` + `.docx`; 3 PDFs only (scans) | unrar (2); LibreOffice (2); OCR (3) |
| `.pdf` | 6 | 3 scans, 3 with a text layer (2 of those single source) | OCR, or a PDF text parser for 3 |
| `.7z` | 2 | headers compressed, contents not listed | 7z |
| `.docx` | 1 | a contract `.docx` that is not the 323-Ա template | nothing |
| `.bin` | 1 | a Word document saved as UTF-16 HTML | LibreOffice |

What each one costs per notice kind, against what is stored:

- **Invitations: 6 of 28 stored paper invitations (21%) are unreadable**, and each one is a
  tender Tendra never shows. That is NFR-DATA-2's coverage and the #1 churn cause. It also
  echoes downstream: ticket 09's ՍՀՏ-ԳՀԱՊՁԲ-2026/20 had a `.rar` invitation, so its failure
  notice became a `no_candidate` with `was_public` true, which is exactly the row the operator
  alert pages on. **unrar would read 4 of the 6** (2 loose, 2 nested in a zip), and 7z the other
  2.
- **Failure notices: 18 of 35 unreadable, 17 of them competitive.** The cost is a tender that
  stays `closed` instead of `cancelled`, and a bid on it that waits instead of resolving `lost`.
  unrar alone reads 6, and LibreOffice reads 8 (5 `.doc`, 2 inside a zip, the HTML `.bin`); together they read 1 more. 3 are scans.
- **Contract notices: 18 of 31 unreadable, but 11 are single source,** and those prices are kept
  out of every comparison anyway. Of the competitive 6, 4 are `.doc` (LibreOffice). The other
  two are a text PDF with no readable code line and a non-template `.docx`, which no converter
  helps.

**Recommendation:**

- **unrar now, 7z with it if the library is cheap.** Together they are the only converters that
  touch invitations (all 6), and unrar also reads 6 failure notices. Both exist as WASM
  packages, so the worker image gains no system binary. Everything is replayed from storage.
- **LibreOffice for `.doc`: not yet.** Its unlock is mostly failure notices (a status, not a
  tender) and 4 competitive contract prices. It costs a headless office suite in the worker
  image (hundreds of MB, process spawning, a timeout policy).
  - Decide on production counts, because this sample is two cold starts.
  - The listing-level counts lean the same way: ticket 09's 180 failure filenames were 41
    `.doc` against 21 `.rar`, but failure notices are the cheap kind to lose.
- **OCR: no.** That is 6 scans, and every one is single source or a failure notice.

The decision is the owner's; open a ticket once it is made.

## For the owner

- **The converter decision above.**
- **Story 32's coverage check has nothing to count.** gnumner's e-auction notices are on their
  own listing ("E-auction p.1", 10 of 10 `tmid` links in research.md). That listing is not in
  `listingPaths`, and `listing_notices` indexes only the invitation listings. The open and
  quotation listings swept so far carried no `tmid` link, so `listing_notices` holds only
  `armeps:` and `paper:` ids.
  - To make the check bite, sweep that listing on the shared chain (one more board slug, counted
    and never ingested) and index its notices.
  - That is about 24 more requests an hour at the current cadence.
  - The script needs no change: it already reads `eauction:` notices from any listing.
