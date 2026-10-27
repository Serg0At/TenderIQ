# 11 — PPCM supplies ՀՎՀՀ for e-auction bidders

**What to build:** e-auction bidders gain their ՀՎՀՀ from PPCM, so the same company is recognised
across all three submission channels. That happens without any name matching and without PPCM
touching e-auction prices, ranks or statuses. ADR 0004: *For e-auctions PPCM adds only the bidder's
ՀՎՀՀ*.

**Blocked by:** 10

**Status:** done

- [x] For awarded e-auction tenders with bidders lacking a ՀՎՀՀ, PPCM rows are fetched by
      procedure code.
- [x] A ՀՎՀՀ attaches to a party only when tender, lot number and **exact** net price all match
      one ledger row. Anything else attaches nothing and is counted.
- [x] PPCM writes no `public_tender_bids` or `awards` rows for e-auction tenders and never changes
      status, rank or rejection there.
- [x] Party resolution matches by ՀՎՀՀ first, by per-source id second, so a PPCM or gnumner bidder
      with a known ՀՎՀՀ reuses the existing party.
- [x] If two parties end up with the same ՀՎՀՀ, that is reported, not auto-merged. Record the
      count.
- [x] Verified on the 12 e-auction tenders found in PPCM on 2026-10-18 (research.md): the number
      of parties that gained a ՀՎՀՀ, and zero price or status changes.

## Verification (2026-10-27, local Postgres `tendra`, MinIO, Redis, live PPCM)

No worker was running. The production refresher (`ppcmRefresher.find`) and handler
(`handlePpcmResults`) were driven in-process; every request went through armeps.am's rate
limiter, ≥ 3 s apart — 34 asks in the run, 9 probes before it, 2 re-asks after. No test runner:
the pure rules are 24 assertions in a scratch script (real answers and synthetic rows) and
party resolution 14 more, inside transactions rolled back.

**Result: 72 parties gained a ՀՎՀՀ** (182 → 254 parties with one; all 72 are `eauction:bo:*`
suppliers, which held none before). **0 price or status changes**: `tenders`,
`public_tender_bids`, `awards`, `tender_sources` and `unmatched_results` checksums identical
before and after the run; `parties` changed in `tax_id` only (`id, source_id, name, role,
region` checksum identical). **0 parties share a ՀՎՀՀ on the supplier side**, and no buyer and
supplier share one; the only shared ՀՎՀՀ in the database predates this ticket — two buyers,
01506928, ԵՐԵՎԱՆԻ ՊԵՏԱԿԱՆ ՀԱՄԱԼՍԱՐԱՆ ՀԻՄՆԱԴՐԱՄ and its Իջևան branch.

**The sample.** The 12 tenders of 2026-10-18 were found by hand and never recorded by code, and
the database was re-imported since. The refresher's first batch was used instead: 60 picks, 26
ARMEPS (claims released afterwards, never asked) and **34 e-auctions**, oldest deadline first
(08-24 → 08-26) — the population the 10-18 check drew from, and the same misses
(ԱՄԱԿ-ԷԱՃԱՊՁԲ-26/40, ՀՀՎԱ-ԷԱՃԱՇՁԲ-26/51, ՎԲԿ). **16 of 34 were in PPCM** (research: 12 of 24).
All 16 resolved by rule 3 to their tender (`link`, rule `code`); **308 PPCM bidder rows, every
one joined exactly one ledger bid** on lot and exact net, and every unmatched count was 0.

| tender | PPCM bidders | parties gained | already held (from an earlier tender in the run) |
|---|---|---|---|
| ՀԱԷԿ-ԷԱՃԱՊՁԲ-103/26 | 42 | 5 | 0 |
| ՀՀ ԱԱԾ-ՏՆՏՎ-ԷԱՃԱՊՁԲ-26/32-ՄՆ | 1 | 1 | 0 |
| ՀՀԿԳՄՍՆԷԱՃԾՁԲ-26/156 | 3 | 3 | 0 |
| ԵՊՀ-ԷԱՃԱՇՁԲ-26/184 | 70 | 10 | 0 |
| ԵՔ-ԷԱՃԾՁԲ-26/130 | 6 | 5 | 1 |
| ԵՔ-ԷԱՃԱՊՁԲ-26/323 | 10 | 2 | 0 |
| ԵՔ-ԷԱՃԱՊՁԲ-26/329 | 4 | 3 | 1 |
| ԵՔ-ԷԱՃԾՁԲ-26/129 | 5 | 3 | 2 |
| ԵՔ-ԷԱՃԾՁԲ-26/131 | 12 | 1 | 9 |
| ԵՔ-ԷԱՃԱՊՁԲ-26/324 | 20 | 5 | 7 |
| ԿԾԿԾԻԳ-ԷԱՃԱՊՁԲ-26/27 | 10 | 6 | 4 |
| ԷԲԿ-ԷԱՃԱՊՁԲ-26/51 | 14 | 2 | 5 |
| ՀՀ ՆԳՆ ԷԱՃԱՊՁԲ-2026/Ս-38 | 11 | 4 | 2 |
| ԵՊՀ-ԷԱՃԱՇՁԲ-26/185 | 10 | 1 | 7 |
| ՀՀ ՆԳՆ ԷԱՃԱՊՁԲ-2026/Է-55 | 78 | 15 | 19 |
| ՀԾԿՀ-26/12-ԷԱՃԱՊՁԲ | 12 | 6 | 6 |

"Bidders" are distinct (lot, bidder, net) rows; a party that bid on several lots gains its
ՀՎՀՀ once, and "already held" counts rows. Not in PPCM (18): ԲՏՀՁՀ-26/36, ՍԱԲԿ-26/54,
ՀՀ ԱԱԾ-ՏՆՏՎ-26/31-ԱՎՏՈՄԵՔԵՆԱ4, ԱՍՀՆ-26/59, ՀՀՎԱ-26/51, ԱՄԱԿ-26/40, ՎԲԿ-26/21,
ՀՀՇՄԱՀ-26/26, ԱՐԶՆԻՀ-ԷԱՃ-2026/4, ԻՀԱԿ-26/78, ԶՄՄԱԲԿ-65/26, ՀՀԱՄՄՀ-26/16-ՀՈԱԿ, ՄԲԿ-26/59,
ՀՀԱՄԱՇՏ-26/19, ՀՀԱՆՇՕԾ-ԷԱՃԾՁԲ-2026/56, ՏՄ-ՆԲԿ-26/44, ՄԲԿ-26/18, ՀՀԱՆՇՕԾ-2026/57 (all
`ԷԱՃ…ՁԲ`). Their empty answers are stored; they stay on the worklist.

### The rest of the box list

- **Worklist** (`tenders.findAwaitingTaxIds`): 673 → 635 after the run. The 18 asked that
  are still on it are exactly the 18 PPCM did not report; 22 tenders never asked dropped off
  because every bidder gained its ՀՎՀՀ on another tender. A second `find` picked 60 new
  e-auctions and none of the first batch (claims, `taxIdPollHours` = 72); its claims were
  released, so only the 34 real asks hold one.
- **Never a price, rank, status, rejection or link**: `recordTaxIds` resolves, then calls
  `BidderTaxIdService.attach`, whose only write is `parties.setTaxId` (blank only). Checksums
  above.
- **Idempotent**: a re-ask of Է-55 → `unchanged`, resolved again (an e-auction never holds a
  PPCM link), 0 gained, 78 already; a `replay` → the same; every checksum identical.
- **The exact join** (pure): one cent off → `no_bid`; another lot → `no_bid`; two bids of ours
  at one lot and net → `several_bids`; two PPCM bidders at one → `ambiguous`; no PPCM ՀՎՀՀ →
  `no_tax_id`; one party matched to two ՀՎՀՀ → `conflicting`, nothing attached; a party holding
  another → `holds_other`, never overwritten; every bidder in exactly one count. A lot
  `ledgerLot` leaves unread (contracts that cannot be placed) still names its bidders —
  `observation.bidders` is read off the raw rows.
- **ՀՎՀՀ first** (rolled back): a PPCM bidder whose ՀՎՀՀ an e-auction party holds → that
  party, its name, `source_id` and role untouched, no `ppcm:bo` row; a gnumner bidder stating one
  → the same; no ՀՎՀՀ → the per-source id, never the name; an unknown one → a new
  `ppcm:bo:{ՀՎՀՀ}`, renamed only by its own source; two holders → the per-source id, the
  third holder reportable; a **buyer** holding it → not reused (below). ARMEPS 26/30 replayed
  through the new resolution: its two bids and award are the same parties and amounts as
  ticket 10 recorded (the replay rewrites row ids and `fetched_at`, as every PPCM replay does).

## Decided while building

- **PPCM writes an e-auction's times as Yerevan wall clock in UTC.** Its announcement and
  opening were exactly +4.00 h from eauction.armeps.am's on all 16 matched tenders, while its
  ARMEPS times equal armeps.am's to the minute (26/30). Read as given, an e-auction announced
  after 20:00 Yerevan falls on the next day and rule 3 refuses it — 34 of 673 awarded
  e-auctions. `ppcm/observation.js` moves an e-auction's `publishedAt`/`deadlineAt` back 4 h;
  the procedure id keeps PPCM's own clock (an id only has to be stable). None of the 16 was
  near the boundary, so the correction is verified by the offset, not by a rescued tender.
- **"Awarded" is "holds an award", not `status = 'awarded'`**: 341 e-auctions are `closed`
  with awards (the auction is decided, the contract not yet signed), and PPCM lists them too.
- **E-auctions ride the existing `refresh-ppcm`**, in the room the ARMEPS asks leave, each
  code every 72 h: about half are never in PPCM and stay on the list to the end of the window,
  so asking daily would fill the batch. No new repeatable job, no scheduler step.
- **A bidder is never folded into a buyer row by ՀՎՀՀ.** ՀՎՀՀ-first resolution counts only
  holders of the same role or `both`. Whether a buyer and a bidder holding one ՀՎՀՀ are one
  party is ticket 19's to decide, and a branch can carry its parent's (01506928 above). Until
  then such a pair is two rows, reported when an attach creates it.
- **Duplicates are reported where they are made**: `attach` logs every ՀՎՀՀ that two parties
  hold after it filled one, and returns them (`shared`). The upsert's two-holder fallback creates
  no new duplicate pair (it only adds to one already reported). The count recorded here is a
  hand query.
- **An unmatched e-auction procedure is logged, not stored**: recording PPCM results that
  Tendra has no tender for is ticket 12's sweep.
- **Found on the way, fixed (ticket 10's):** a PPCM answer's storage key URL-encodes the code,
  six characters an Armenian letter, and «ՀՀ ԱԱԾ-ՏՆՏՎ-ԷԱՃԱՊՁԲ-26/31-ԱՎՏՈՄԵՔԵՆԱ4» overflowed
  `source_payloads.storage_key` (255) after the procedures had been recorded — failing on every
  retry. The key now carries a digest of the code (`results-{sha256}`); `ref` keeps the code.
  Existing rows keep their keys. The orphan object the failed write left was removed.
- **Migration**: `migrations/add_parties_tax_id_index.js` (not unique, on purpose), run twice on
  local `tendra`, mirrored in `create_table.js`, **ticket 30 step 13**.

## Open

- **The window bounds the archive out.** `findAwaitingTaxIds` reuses PPCM's 90-day
  `refreshWindowDays`, so e-auctions older than that — the whole archive once the backfill
  runs — never gain a ՀՎՀՀ. A ՀՎՀՀ does not go stale the way a pending result does, so a
  deliberate backfill (ask by code over the archive, at `PRIORITY.RESULTS`) is the likely
  answer. Not built: the backfill is still off, and its pace is the owner's call.

## Review (2026-10-27, `/code-review`, standards and spec axes)

Fixed: `biddersOf` had been inserted between `pricedAsOffer` and its doc comment (the
"SQL twin — change both" contract); `at` → `timeOf`, `attach` → `toAttach`; `sharedTaxIds`
had no caller and was removed; ՀՎՀՀ-first could fold a bidder into a buyer row — now same role
only. Left, on purpose: `findAwaitingTaxIds` repeats `findAwaitingResults`' window skeleton
(two worklists with different predicates; folding them couples ARMEPS results to e-auction
ՀՎՀՀ); the procedure id keeps PPCM's uncorrected clock (above); the archive window (Open).
