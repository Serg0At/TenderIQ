# 4. A tender is one run, assembled from several sources

Date: 2026-10-19

## Status

Accepted

## Context

Tendra reads one source today: eauction.armeps.am, where one site supplies the listing, the
detail page and the bid ledger. Covering the other two **submission channels**, ARMEPS sealed bids and paper,
splits those three jobs across three sites
(`.scratch/procurement-sources/research.md`):

| Job | ARMEPS | Paper |
|---|---|---|
| Discovery | gnumner listing, linking to armeps.am | gnumner listing, an uploaded file |
| Detail: deadline, CPV, documents | armeps.am tender page | inside the uploaded file |
| Results: bidders and prices | PPCM | gnumner contract-concluded `.docx` |

So one tender now arrives in pieces, and the pieces share no common identifier. The obvious
join key, the **procedure code**, is not unique. In the local database 1,152 e-auction tenders
carry 1,146 distinct codes: a buyer cancels and re-announces under the same code within days, and
in one case (`ԱՄԱԿ-ԷԱՃԱՊՁԲ-26/40`) both runs were awarded. Codes also arrive spelled differently:
«» quotes, an en dash, inner spaces, or missing from a gnumner title entirely.

## Decision

**A tender is one run of a procedure.** `tenders.id` stays the only identity and is never derived
from a source. A re-announcement under the same code is a new tender; the code is an attribute
and a matching hint.

**A tender records every source it came from.** Each link is a `(source, external_id)` pair,
unique across the table, with its URL, its role and what that source last said about status. The
external ids are the eauction tid, the armeps.am `resourceId`, the gnumner notice URL (gnumner has
no ids) and, for PPCM, the `resourceId` where bid-report gives it, otherwise the code and dates.

**Matching runs in a fixed order, and the first decisive rule wins:**

1. The `(source, external_id)` pair is already linked: it is that tender.
2. The source points at another one: a gnumner item linking to an armeps.am `resourceId` joins
   that tender, so one tender never becomes two records.
3. A result with no pointer is matched on normalized code, submission channel and dates.
4. Anything still unresolved becomes an **unmatched result**, stored with its reason
   (`no_candidate` or `ambiguous`) and counted. It is never guessed onto a tender, for the same
   reason a supplier identity is never matched on name: a wrong guess attaches one company's
   result to another tender invisibly.

**A `no_candidate` result means Tendra missed a tender, and it repairs itself where it can.** If
the result carries a `resourceId`, the armeps.am page is fetched and the tender created the normal
way, and the result then attaches to it. `ambiguous` results (about 0.5%) are stored and counted,
not resolved by hand.

**In production, every missed tender raises an operator alert** to the owner's private Telegram
chat, so a broken worker is fixed in hours rather than discovered by a customer. Operator alerts
are a separate, later feature that other critical errors will join; they read the unmatched
results this decision stores. They fire on live ingestion only: a history backfill or a
development run raises none.

**In live mode, result sources never create tenders.** This follows the rule that the listing
writes no domain rows. The one exception is a deliberate PPCM history backfill (2019–2025), whose
tenders carry only a PPCM link and are never biddable.

**One source owns each status, per submission channel**, and status only moves forward:

| Submission channel | Open, deadline | Awarded | Cancelled |
|---|---|---|---|
| e-auction | eauction | eauction ledger | eauction |
| ARMEPS | armeps.am | PPCM | PPCM failed report, gnumner «Չկայացած» |
| Paper | gnumner invitation | gnumner contract `.docx` | gnumner «Չկայացած» |

**For e-auctions PPCM adds only the bidder's ՀՎՀՀ.** PPCM's prices matched the ledger on 95 of 95
rows, but its `bid_rejected` flag disagreed in 28. The ՀՎՀՀ attaches to a party only when tender,
lot and exact price all match: a structural match, not a name match. gnumner's own e-auction
items are skipped, because they point by a `tmid` UUID that no stored eauction page contains.

**The source key `armeps` is renamed `eauction`** before armeps.am becomes a second source.

## E-auction amendments (2026-10-21, ticket 29)

eauction.armeps.am amends a tender by publishing a **new tid**. The new page lists every run it
replaced under «Աճուրդի սկզբնական հրավեր(ներ)»; the old page turns Փոփոխված and leaves the
listing. That list is a pointer in the sense of rule 2, so **the replacement joins the tender
of the run it names**, and the join is an amendment: `version + 1`, one alert naming the moved
fields and the archive's changed files. Two consequences:

- **The pointer decides, not the code.** A same-code tender that names no predecessor is a
  re-announcement and a new run, as above. The six re-announced codes checked on 2026-10-21 carry
  no block; the one block among them (48135 → 48118) is a separate amendment, cancelled
  afterwards and re-announced as 48140.
- **A tender's current link is not its creating link.** The named runs become `superseded` links
  (`tender_sources.observed_status`, sticky), recorded with no request, even for a predecessor
  Tendra never fetched. A superseded link is never refreshed, and its pages and archives write
  nothing but the link. The refresh and the document stage read the one current link per
  source; `tenders.source_id` stays the creating link. When the predecessors are on two different
  tenders, the replacement is created as a new run and the join is recorded as an `ambiguous`
  unmatched result naming both. Nothing is merged, and the tender is not missed.

## Paper invitations (2026-10-21, ticket 06)

A paper tender's detail is the file a gnumner notice uploads, and **its external id is the file's
content hash, not its URL**. Buyers sometimes upload the same file twice, minutes apart, under a
new path each time (five byte-identical pairs among 56 uploads on 2026-10-19/20): keyed by URL,
that is two tenders for one procurement. Keyed by content, the second upload resolves by rule 1
to the same tender, and its notice is one more `discovery` link (`paper:{digest of the path}`)
pointing at the file by rule 2. No new merge rule was needed. A buyer who re-issues a *changed*
invitation uploads different bytes, which is a different tender until the amendment listing
(ticket 07) joins them — seen once: ԵՊՊՔ-ԳՀԱՊՁԲ-26-3, uploaded on 10-08 and again on 10-12 with
the day count adjusted to keep the same deadline.

Two reasons join `no_candidate` and `ambiguous` on unmatched results. A file the parser cannot
read is `unsupported_format` and creates nothing; a tender created with no readable code is
`no_code`, because no result can ever be matched to it by rule 3.

## Considered options

- **A tender is a procedure code, with runs inside it.** One card per code, but alerts, pursuits
  and bids all belong to a run, so every reader would need one more level. Rejected.
- **Attach an ambiguous result to the likeliest tender.** Rejected: a silent wrong attachment is
  worse than a counted gap.

## Consequences

- Coverage becomes measurable per source: matched versus unmatched, each with its reason.
- Paper files that cannot be read (`.doc`, `.rar`, scans) are counted as `unsupported_format`.
  They are meant to become supported once the counts show which formats matter.
- The rename touches `tenders.source_id`, `source_payloads`, storage keys, the `source` columns
  and the Redis sweep keys. It is cheapest now, before the archive backfill.
