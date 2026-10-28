# 19 — One buyer across submission channels, joined by ՀՎՀՀ

**What to build:** A buyer that procures by e-auction and through ARMEPS is one party, so its buyer
profile (spend, suppliers, prices) covers both channels instead of splitting in two. Found in ticket
05: 25 of the first 31 ARMEPS buyers already exist as e-auction parties under the same name.
Decided 2026-10-20: buyers are joined **by ՀՎՀՀ only, never by name**. That is the same reason a
supplier identity is never matched on name: scraped Armenian legal names quote inconsistently, and
a wrong merge is invisible.

**Blocked by:** 10, 11

**Status:** done

- [x] An ARMEPS buyer gets its ՀՎՀՀ from a structural source, never a name lookup:
  - from its stored invitation documents, if they carry it the way e-auction invitations do
    (`invitation.parser.js` already reads it there; check a sample first and record the hit rate);
  - ~~otherwise from PPCM, when a PPCM result has attached to that buyer's tender (ticket 10).
    The tender match is the join, and the PPCM authority's ՀՎՀՀ then belongs to that tender's
    buyer.~~ **Dropped**: no PPCM answer states the authority's ՀՎՀՀ, so there is nothing to
    join to; only a by-name search does (Result, *Where a buyer's ՀՎՀՀ comes from*; Open).
- [x] Party resolution matches by ՀՎՀՀ first, by per-source id second (ticket 11 builds this for
      bidders; buyers use the same path). **Not the same path, on purpose**: a buyer resolves by
      per-source id, gives that row the ՀՎՀՀ, and the merge decides. Ticket 11's path adopts a
      lone holder whatever its name (*Decided while building*).
- [x] Existing duplicates are merged where both parties hold the same ՀՎՀՀ: tenders and every other
      reference move to one party, then the other is removed, in one transaction per pair.
      Record the count of merged pairs.
- [x] A buyer with no ՀՎՀՀ on either side stays split. It is counted, not merged by name. Record
      how many of the 25 remain split and why.
- [x] Buyer profiles and buyer-specific benchmarks read the merged party. Check one merged buyer's
      profile before and after, and record it.
- [x] Two parties holding one ՀՎՀՀ with clearly different names are reported, not merged blindly.
      Record what was found.

## Result (2026-10-28, local Postgres `tendra`, MinIO)

**17 pairs merged, 2 groups refused (stayed split).** Every merged pair is an ARMEPS buyer and
an e-auction buyer of one ՀՎՀՀ; 14 kept the e-auction party, 3 the ARMEPS one (it had more
tenders). Of the **26** ARMEPS buyers that exist as e-auction parties under the same name
(ticket 05 counted 25 of the first 31; there are 33 ARMEPS buyers now), **17 merged and 9 stayed
split**. Paper: **17 of 18** paper buyers gained a ՀՎՀՀ, **0 merged** — none shares one with a
buyer of another channel — and one group of two paper buyers was refused (below).

Run with `npm run buyers:merge` (dry run, rolled back: 17 / 2), then `-- --apply` (17 / 2), then
`-- --apply` again (0 / 2, nothing read gained a ՀՎՀՀ — idempotent).

### Where a buyer's ՀՎՀՀ comes from

- **Not "the way e-auction does" — the template's field.** E-auction takes the one ՀՎՀՀ a whole
  invitation agrees on. ARMEPS and paper sets print other numbers beside the buyer's: both
  national parks print the environment ministry's 02507198 beside their own, a bank's appears in
  payment details, and the education ministry's ARMEPS set prints «ՀՎՀՀ 002698732». So the
  reader takes field 11 of the Ministry of Finance template's bank-guarantee form, «Շահառուի ՀՎՀՀ`
  NNNNNNNN» (the guarantee's beneficiary is the buyer), exactly eight digits, agreed across every
  Word document of the set (`libs/taxId.js`). Checked against e-auction first: on 300 stored
  e-auction invitation texts the field held one value in 294, and **all 294 equalled the ՀՎՀՀ
  e-auction's own rule had stored**.
- **Hit rate (the sample: every stored set, 2026-10-28).** ARMEPS: 54 document sets of 32
  buyers; the field is in a .docx in **34 sets → 21 buyers**. A .doc or .pdf reader would add
  9 sets and 2 buyers (antiword/pdftotext, by hand); 11 sets carry the field in no readable file.
  Paper: **21 of 21** invitations → 17 of 17 buyers with one. The production readers
  (`armeps/documents.js#buyerTaxIdOf`, `gnumner/invitation.parser.js`) agreed with an independent
  Python reading on all 75 sets.
- **PPCM: not used.** Neither of its answers carries an authority ՀՎՀՀ — the organized-procedures
  report has `authority_name` and no tax column, bid-report has `authorityName` only. Its one
  source of a buyer's `tin` is `autocomplete/get-authority-list`, which is searched **by name**,
  so it is ruled out by this ticket's own rule. The tender match cannot be the join when the
  matched row states no number. Open below.
- **The nine-digit guard.** The education ministry is 02698732 on e-auction; the ARMEPS set's
  «002698732» read as its first eight would be 00269873, a different number. Both readers now
  require exactly eight digits. On e-auction's rule this changes nothing stored: 0 of 1,093
  stored e-auction texts has a nine-digit run.

### The nine same-name ARMEPS buyers that stayed split

All nine: the e-auction side holds a ՀՎՀՀ, and the ARMEPS side has none.

| buyer | e-auction ՀՎՀՀ | why the ARMEPS side has none |
|---|---|---|
| Բարձրագույն կրթության և գիտության կոմիտե | 02704199 | field only in a .doc (2 sets); a .doc reader gives 02704199 |
| ԿԱՐԵՆ ԴԵՄԻՐՃՅԱՆԻ ԱՆՎԱՆ ԵՐԵՎԱՆԻ ՄԵՏՐՈՊՈԼԻՏԵՆ ՓԲԸ | 00000911 | field only in a .doc; a .doc reader gives 00000911 |
| ՀՀ ԿՐԹՈՒԹՅԱՆ … ՍՊՈՐՏԻ ՆԱԽԱՐԱՐՈՒԹՅՈՒՆ | 02698732 | no field; only «ՀՎՀՀ 002698732» in payment details (nine digits) |
| Վաղարշապատի համայնքապետարան | 04463138 | no field in any .docx, .doc or .pdf (the set holds a .rar) |
| Թալինի քաղաքապետարան | 05030561 | the same (the set holds a .rar) |
| Առողջության համընդհանուր ապահովագրության հիմնադրամ | 00542809 | no field in any .docx or .pdf |
| Գյումրու բժշկական կենտրոն ՓԲԸ | 05539526 | the same |
| Աշոցքի համայնքապետարան | 05544291 | the same |
| ՀՀ Կոտայքի մարզ Հրազդանի քաղաքապետարան | 03027114 | the same |

None is merged by name. A .doc reader (the format work `unsupported-formats` already wants)
would merge the first two on a re-run of `buyers:merge`.

### Two parties holding one ՀՎՀՀ: what was found

- **01506928 — refused, as decided.** «ԵՐԵՎԱՆԻ ՊԵՏԱԿԱՆ ՀԱՄԱԼՍԱՐԱՆ ՀԻՄՆԱԴՐԱՄ» and «… ՀԻՄՆԱԴՐԱՄԻ
  ԻՋԵՎԱՆԻ ՄԱՍՆԱՃՅՈՒՂ», both e-auction buyers. A branch prints its parent's number.
- **02625503 — refused, and probably one buyer.** Two paper buyers, «Հիվանդությունների վերահսկման և
  կանխարգելման ազգային կենտրոն» ՊՈԱԿ and the same with the ministry's «ԱՆ» in front. The names
  differ by more than quoting and case, so the rule refuses it, as it must refuse the branch.
  **For the owner:** if it is one buyer, `npm run buyers:merge -- --apply --confirm 02625503`.
- **Buyer and supplier sharing one: 2, left alone** (04418902, 05804656 — each an e-auction buyer
  and an e-auction bidder row). Never folded together.

### Buyer profile before and after: ՀՀ Արարատի մարզ Մասիսի համայնքապետարան (04240324)

`ProfileService.forBuyer`, all time. Before, two parties: the e-auction one (12 tenders) and
the ARMEPS one (1 tender, one PPCM award). After, one party (the e-auction id, kept), and both
`eauction:buyer:a74ebc83b1ac17b2` and the alias `armeps:buyer:a74ebc83b1ac17b2` resolve to it.

| | e-auction party before | ARMEPS party before | merged after |
|---|---|---|---|
| tenders | 12 (eauction) | 1 (armeps) | **13** (12 + 1) |
| tenders awarded | 7 | 1 | **8** |
| lots awarded | 17 | 1 | **18** |
| total spend (AMD) | 10,792,176.82 | 12,369,600 | **23,161,776.82** |
| distinct winners | 9 | 1 | **10** |
| competition sample lots | 24 | 1 | **25** |

Buyer-specific benchmarks read `tenders.buyer_id` too, so they follow; the merge deletes every
holder's stored buyer rows (stale), and a read computes live until the nightly recompute. Local
`price_benchmarks` held no buyer rows, so nothing was deleted here.

### Nothing else moved, and nothing re-alerts

- Checksums before and after `--apply`: `tenders` (all columns but `buyer_id`), `awards`,
  `public_tender_bids`, `tender_sources` identical; `notifications` 0 → 0; `parties` 998 → 981;
  `party_aliases` 0 → 17.
- **Replay, in-process** (`normalizeTender`, backfill priority, no worker running) of every
  detail link of a merged buyer's tender and every paper tender — 270 links: **0 buyer moves,
  0 parties created**, no event, except one `TenderAmended` on `status` alone. That one is
  ARMEPS 12538123, whose deadline was 2026-10-28 12:00 and which closed on the clock. Without the
  alias, every ARMEPS replay of a merged buyer would have re-created it and been an amendment
  of `buyer_id`.
- **Rolled-back scenarios** (no test runner): 85 assertions on the reader. They cover the field,
  the doubled label, a split paragraph, nine digits, a non-field ՀՎՀՀ, agreement, and all 75
  stored sets against the Python reading. 11 scenarios cover resolution (re-run after the review):
  - a paper buyer stored before its ՀՎՀՀ merges when its invitation states it, and the tender
    moves before it is compared;
  - a replay without the ՀՎՀՀ resolves through the alias and creates no row, and the survivor's
    name is kept;
  - a different name is refused, keeps its tenders, and `confirmed` merges it;
  - a branch first seen with its parent's ՀՎՀՀ becomes its own party, refused and reported
    (not adopted);
  - a new paper buyer of the holder's name lands on the holder, and no row is left behind;
  - 01506928 is refused;
  - 04418902's supplier row is untouched, and a buyer stating it resolves to the buyer row;
  - a source row holding a different ՀՎՀՀ keeps its tender;
  - a buyer with no ՀՎՀՀ, and a supplier, resolve as before.

  The document stage (`applyInvitationFacts`) merges a same-name holder, refuses a different
  name, and returns it as `buyersShared`.

## Decided while building

- **The ՀՎՀՀ decides; a name can only veto.** The first rule refused a group only when one
  source held two of its buyers, on the idea that a source tells its own buyers apart. It does
  not: every buyer's per-source id is a hash of its name, so two rows of one source are two
  spellings. The dry run showed it from both sides. It refused 02625503, a re-spelling. And it
  would merge a branch into its parent whenever the two came from different channels, which is
  the case this ticket says must be reported. So holders whose names differ by more than
  quoting and case (`identityKey`, the rule a buyer's per-source id already uses) are refused
  and reported. Same outcome on today's data (17 / 2), for a reason that holds. A refused group
  merges only on `--confirm`, a person's decision.
- **Merging needs an alias, not only a delete.** `buyer_id` is in the amendment hash, and an
  ARMEPS page states no ՀՎՀՀ. A deleted `armeps:buyer:…` would be re-created by the next
  refresh and the tender moved back to it, as an alerted amendment. The dead per-source id
  is kept in `party_aliases`, and `upsert` resolves it third. The aliases of a merged-away
  survivor follow it.
- **Merging happens where the ՀՎՀՀ is learned, not only in the script.** `upsertBuyer`
  resolves by per-source id (or alias) only, gives that row the ՀՎՀՀ, and lets `mergeBuyers`
  decide, so the tender is already on the survivor when `saveNormalized` compares it; otherwise
  a paper replay would move its buyer (an amendment). It never takes ticket 11's ՀՎՀՀ-first
  path, which adopts a lone holder whatever its name. The review caught that: a branch first
  seen on a paper invitation would have joined its parent silently. In `applyInvitationFacts`,
  whichever archive comes second merges. A refusal is logged where it happens: by the
  normalizer, and by `AddendumService.recordDocuments`.
- **`buyers:merge --apply` merges one transaction per group**, as the ticket asks. The dry run
  is one transaction, rolled back, so its counts are exact.
- **Survivor = most tenders**, so a buyer id a supplier already opened usually stays valid.
- **Only `role = 'buyer'` merges.** A buyer row is never a bidder (supplier resolution reaches
  only `supplier`/`both`), so moving `tenders.buyer_id` moves every reference. `buyer_profiles`
  cascades; `price_benchmarks.buyer_id` is `SET NULL` and would turn a stale buyer row into a
  duplicate global one, so the merge deletes those first.
- **Migration**: `migrations/add_party_aliases.js`, run twice on local `tendra`, mirrored in
  `create_table.js` and `drop_table.js`, **ticket 30 step 14**.

## Review (2026-10-28, `/code-review`, standards and spec axes)

**Fixed:**
- buyer resolution adopted a lone ՀՎՀՀ holder whatever its name (above);
- the script ran every merge in one transaction (now one per group);
- the PPCM bullet was ticked though dropped;
- `mergeBuyers` took options after `trx` (now `trx` last);
- the script copied the worker's ARMEPS reader and had already drifted from it (now
  `workers/armeps.js#readBuyerTaxId`, shared);
- an unused `buyerTaxId` export was removed;
- `ownRow` → `resolveSourceId`, `buyersShared` → `buyersRefused`.

**Left, on purpose:**
- `armeps/documents.js` imports `gnumner/word.js`, a generic Word reader rather than a gnumner
  parser;
- `fillAndMergeBuyers` owns its transaction, as `saveNormalized` does;
- the storage-key parse mirrors `tenderDocument.service.js`;
- e-auction keeps its own ՀՎՀՀ rule, verified against this one;
- the nine-digit guard on e-auction's rule touches a channel this ticket does not cover. It
  changes nothing stored.

**For the owner — the strictness of the name veto.** Any name difference beyond quoting and
case refuses a merge. Because a buyer's per-source id is already the hash of that same key, an
automatic merge in practice needs equal names. The ՀՎՀՀ stops wrong merges but adds none that
names would not. A re-spelling (02625503) waits for `--confirm`. The alternative, a narrower
veto such as a branch marker («ՄԱՍՆԱՃՅՈՒՂ»), merges more, but on a word list. Kept strict
until you decide.

## Open

- **A .doc (and .pdf) reader** would merge 2 more of the 9 (above); `buyers:merge` replays it
  from storage. Same converter question as gnumner's `unsupported_format`.
- **PPCM's authority `tin`** exists only behind a search by name. If the owner decides that a
  PPCM name taken from a matched PPCM row is acceptable (it is the source's own exact string,
  not ours), it would cover buyers whose sets carry no field. Not built.
- **02625503** waits on the owner's `--confirm`.
- **Neon** is not touched: ticket 30 step 14.
