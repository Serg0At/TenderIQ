# 32 — An organization is one bidder across all three submission channels

**What to build:** An organization that claims its supplier identity gets win/loss reconciliation
on e-auction, ARMEPS **and** paper bids, not only on the channel where its claimed party came
from. Found in ticket 08: a paper bidder is keyed by name, so it is a different party from the
same company's e-auction party, and `organizations.supplier_party_id` holds one party.

**Blocked by:** 11, 19

**Status:** done

Decided 2026-10-23. Never match a party on name (CLAUDE.md, *supplier identity*), and prefer the
ՀՎՀՀ, the only structural identifier there is:

- [x] **First, merge by ՀՎՀՀ.**
  - Check whether the 323-Ա contract notice states the winner's or each bidder's ՀՎՀՀ (the template
    names a «Ընտրված մասնակից»; record what it carries). If it does, paper parties get it, and
    ticket 11's "ՀՎՀՀ first" party resolution merges them with the e-auction and PPCM party of
    the same company.
  - Record how many paper parties merge.
- [x] **Then, for parties with no ՀՎՀՀ anywhere, an organization may claim more than one party,**
      each as a separate deliberate human claim from a search, exactly as the single claim works
      today.
  - The claim becomes a set (for example, a `supplier_identities` table keyed by organization
    and party, with the private-table rules: `organization_id` on the row, composite foreign
    keys where they apply).
  - `supplier_party_id` is migrated into it.
  - Reconciliation, win rate and "did we win" read the set.
- [x] A party can be claimed by at most one organization, as today. Record whether that holds now,
      and keep it.
- [x] `/organization/supplier-identity` lists, adds and removes claims. The API reference is
      updated.
- [x] Win rate still obeys `INTELLIGENCE.MIN_COMPARABLES` over the union of claimed parties.
- [x] If you add a migration, add it to ticket 30's list.

## Result (2026-10-28, local Postgres `tendra`, MinIO)

### The 323-Ա notice states the winner's ՀՎՀՀ, and only the winner's

Its last table, «Ընտրված մասնակցի (մասնակիցների) անվանումը և հասցեն», has one row per contract:

    Չափա-բաժնի համարը | Ընտրված մասնակիցը | Հասցե, հեռ. | Էլ.-փոստ | Բանկային հաշիվը | ՀՎՀՀ / Անձնագրի համարը և սերիան

**Every one of the 14 readable stored notices has it** (31 stored: 15 .zip/.docx, 8 .doc, 5 .pdf,
3 .rar). The price and rejection tables name bidders with no number at all, so **a losing paper
bidder has no ՀՎՀՀ** and stays keyed by its name. The column also takes a passport number, and
a foreign winner writes its own (a Bulgarian certifier's is nine digits), so only eight digits
are read. Some buyers repeat the label in the cell («ՀՎՀՀ՝ 06948084»).

`contract.parser.js` now reads that table (it stopped just before it). Its rows attach to the
lot whose contract names the same winner, within the notice. `gnumner/observation.js` puts the
ՀՎՀՀ on the winning bid and the award, and ticket 11's ՀՎՀՀ-first resolution
(`party.repo.js#upsert`) does the rest.

- Over the 31 stored notices: 13 parse as before; **15 lots have a contract, 14 now carry the
  winner's ՀՎՀՀ**, and the 15th is the Bulgarian winner. The parse is otherwise identical to
  HEAD's on all 31 (deep-equal without `winnerTaxId`).
- **Paper parties merged with an e-auction or PPCM party: 0.** None of the 11 distinct winners'
  ՀՎՀՀ is held by any party in local `tendra`, which holds two months of e-auction and 349
  supplier ՀՎՀՀ. Two notices are linked to paper tenders, and their winners are now keyed by
  ՀՎՀՀ (*Review fixes*, 1, below). The first cut wrote the ՀՎՀՀ onto their name-keyed
  parties instead, which the review found wrong. The third paper party, Մեյդ թու Մեյք ՍՊԸ,
  only lost, and has none. On Neon, with a year of PPCM bidders, merges are expected: ticket
  30's `notices:replay` step counts them.

### Claims are a set

- **`supplier_identities`** (`organization_id`, `party_id`, `claimed_by`, `claimed_at`):
  `organization_id` on the row, CASCADE with the organization. Unique on `party_id`. No
  composite key applies — the parent is the organization itself, and a party is public.
  `organizations.supplier_party_id` and its partial index are **dropped**, after the
  migration copies each claim into the table. Two stores of "who are we" would be two answers.
- Reconciliation (`BidOutcomeService.reconcile`, `resolveOne`), "did we win"
  (`publicBid.repo.js#supplierEntriesForTender`) and relevance (`relevance.repo.js#signalsFor`)
  read every claimed party. **A lot is won when ANY claimed party holds its award**: `is_winner`
  is `award holder = any(claimed)`, not "the row's own bidder". Otherwise a lot one of the
  company's parties won would read as lost on the row of another.
- **Win rate** is `bids.outcome` over the organization's own bids, as before, and still
  `insufficient_data` below `INTELLIGENCE.MIN_COMPARABLES` decided bids. It covers the union
  because each bid is resolved against every claimed party. No code changed there.
- **API**: `GET /organization/supplier-identity` lists. `POST` `{ partyId }` claims one more
  (201, the set; a repeat is a no-op). `DELETE …/:partyId` unclaims (204). `PUT` is gone. A
  party another organization holds is 409, and the response never names that organization. An
  unclaim of a party not ours is 404. `docs/API_REFERENCE.md` is updated.

### At most one organization per party: held, and kept

It held before: the partial unique index made two claims of one party impossible, and local
`tendra` held 0 claims. It is kept as `supplier_identities_party_uq`, and the database
arbitrates a race. Verified: a party another organization holds answers 409.

### Verified (no test runner; by hand, against local `tendra`)

- **Migration**, `add_supplier_identities.js`, run twice. The first run had a temporary claim
  on the local organization: `claimsCopied: 1`, column dropped. The second: `claimsCopied: 0`,
  `columnDropped: false`. The temporary claim was removed afterwards.
- **HTTP, through the real app** (an ephemeral port, a session from `AuthService.sessionFor`,
  and a temporary user, membership and second organization, deleted afterwards). 11 checks:
  - GET lists the copied claim;
  - POST adds a second party, and a repeat is a no-op;
  - an unknown party is 404, and no `partyId` is 422;
  - another organization's party is 409, without its id in the body;
  - a lot where claimed party B lost and claimed party A won is `won` over {A, B}, and `lost`
    over {B};
  - the relevance ledger is the union of the claims;
  - DELETE is 204, then 404, and 404 for another organization's claim;
  - the 11th claim is 429 `QUOTA_EXCEEDED`;
  - candidates still answer.

## Decided while building

- **At most 10 claims per organization** (`MAX_SUPPLIER_IDENTITIES`, 429 `QUOTA_EXCEEDED`, the
  shape of the organization-creation cap). A claim is exclusive. A set with no cap would let one
  account claim a market's competitors, and lock the real companies out of their own win
  records. Not asked for.
- **`PUT` replaced, not kept beside `POST`/`DELETE`.** A PUT of one id has no meaning for a
  set, and there is no client yet.
- **The 409 never says whose.** `holderOf` returns only `self`, `other` or `none`.
- **Only eight digits are a ՀՎՀՀ**, in the winners' table as in ticket 19's reader.
- **Migration**: `migrations/add_supplier_identities.js`, mirrored in `create_table.js` and
  `drop_table.js`. **Ticket 30 step 15**: run with the deploy, since the old code reads the
  column it drops.

## Open

- **.doc, .pdf and .rar contract notices** (17 of 31 stored) carry the same table and are not
  read: the same converter question as every gnumner format.
- **The merge count on Neon**: ticket 30's `notices:replay` step, with its query.
- **Two empty name-keyed parties stay locally** (*Review fixes*, 1). Nothing deletes a party that
  has lost every row, so on Neon each re-keyed winner leaves one behind. Those parties show up
  in the claim picker with no bids. Deleting them is a cleanup decision for the owner.

## Review fixes (2026-10-28, owner's three findings; local `tendra`, MinIO, Redis)

No test runner; each was checked by hand.

### 1. A paper winner's ՀՎՀՀ never attaches to a name-keyed party

The first cut let `upsert` fall back to the name key when no party held the ՀՎՀՀ, and then wrote
the ՀՎՀՀ onto that party. The name-keyed party is shared by every notice's bidder of that name,
so a second company of the same name inherited the first one's number.

- **`gnumner/observation.js`**: a bidder the notice gives a ՀՎՀՀ is keyed by it
  (`gnumner:bo:{ՀՎՀՀ}`, as `ppcm:bo:` is), on every lot of that notice, its losing bids
  included (`noticeTaxIds`, `supplierOf`). That is identity within one document. A name the
  notice gives two different numbers gets neither. Nothing carries across notices.
- **`party.repo.js#nameKeyed`**: a `…:bo:name:…` party never takes a ՀՎՀՀ. Not on insert, not
  on `upsert`'s widen, not through `setTaxId`. Buyers are untouched: theirs is ticket 19's
  rule, with the merge's name veto.
- **Assertions** (scratch script, the pure observation plus a rolled-back transaction), all
  passed:
  - a winner's losing bid on another lot carries its ՀՎՀՀ;
  - the other lot's winner, with none stated, stays name-keyed;
  - one name with two numbers gets none;
  - a later notice naming the same bidder with no number keys it by name;
  - a name-keyed upsert given a ՀՎՀՀ stores none, on insert and on re-read, and `setTaxId`
    refuses it;
  - a ՀՎՀՀ-keyed upsert stores it, and a renamed bidder with the same ՀՎՀՀ lands on the same row.
- **Locally:** `tax_id` was cleared on the two name parties that had gained one
  (`gnumner:bo:name:c9f7…` Ագաթոն 06948084, `gnumner:bo:name:aba2…` Ղազար Սարգսյան 56207879).
  Then `npm run notices:replay -- --kind=contract --ref=contract:51b5…,contract:55ce…`. Both
  linked (`awarded`). Where the rows went:

  | | before | after |
  |---|---|---|
  | parties | 980 | 982: `gnumner:bo:06948084` and `gnumner:bo:56207879`, each holding its ՀՎՀՀ |
  | Ագաթոն, tender `whqobfs6…` lots 1 and 5 | 2 bids, 2 awards (805 800 / 2 227 500) on the name party | the same 2 bids and 2 awards on `gnumner:bo:06948084` |
  | Ղազար Սարգսյան, result-only tender `vedolpbx…` lot 1 | 1 bid, 1 award (127 800) on the name party | on `gnumner:bo:56207879` |
  | Մեյդ թու Մեյք (lost both lots, no ՀՎՀՀ) | name party | unchanged, still name-keyed |
  | the two old name parties | | `tax_id` NULL and **zero references** in every table with a foreign key to `parties`, `supplier_identities` included. Left in place (*Open*) |

  Prices, statuses and lots are the same, and each tender holds one party per company.

### 2. `npm run notices:replay`

`src/scripts/replayResultNotices.js`. It replays stored gnumner contract and failed-procedure
notices through their production handlers (`handlePaperContract`, `handlePaperFailed`) as the
`retry` job, in this process. It prints what each notice became.

- **Filters:** `--kind=contract,failed` (both by default), `--ref=<ids>`, and
  `--unmatched=<reason>` (a new `unmatchedResult.repo.js#findOpenByReason`). The last is for
  ticket 33's `unsupported_format` rows.
- **Queued work:** what the handlers queue goes to the queues at backfill priority. No
  invitations: their replay is `normalize:replay`.
- **Run locally on every stored notice**, after the two-notice replay above:
  - 31 contract notices: 2 linked (`awarded`), 10 `no_candidate`, 18 `unsupported_format`,
    1 `no_code`.
  - 35 failure notices: 3 linked (`cancelled`), 12 `no_candidate`, 18 `unsupported_format`,
    1 `no_code`, 1 skipped (`other_channel`).
- **It changed nothing, and alerted nothing:**
  - the checksums of `tenders`, gnumner's `public_tender_bids` and `awards`, and the party
    count were identical before and after;
  - `tenders`, `notifications` (0) and `unmatched_results` were identical to before fix 1;
  - every queue's counts were identical.
- **The `--unmatched` filter:** `--kind=contract --unmatched=unsupported_format` selected
  exactly the 18 unreadable contract notices.
- **Errors:** an unknown `--kind` is refused.
- **Ticket 30:** a new after-deploy step. It records the claims on name-keyed paper parties
  first, since their re-keyed wins move to the ՀՎՀՀ party, and the merge count after.

### 3. The 10-claim cap no longer races

`claimSupplierParty` reads the holder, counts and inserts in one transaction. That transaction
holds `organizations.lockForUpdate` on the organization row, the organization deletion's lock.
A second claim of the same organization waits, then counts the first. Between organizations the
unique index on the party still decides, and `add` returning false is a 409.

Verified through the real app: an ephemeral port, sessions from `AuthService.sessionFor`, and two
temporary owners and organizations, all deleted afterwards. Run three times, the same each time:

- **Organization A** held 8 claims and sent 6 concurrent POSTs for 6 different parties: **2 × 201,
  4 × 429 `QUOTA_EXCEEDED`**, and it holds 10.
- **A and B** claimed one party at once: **one 201, one 409 `CONFLICT`**, one holder.
- **Control:** the pre-fix order (count, then insert, no lock), driven concurrently through the
  repository on organization B at 8 held: **14 claims**, the race the fix closes.
