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
