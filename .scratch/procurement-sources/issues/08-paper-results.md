# 08 — Paper results: every bidder's price

**What to build:** A supplier sees every bidder's price on a finished paper tender. Competitor
prices, benchmarks and bid reconciliation work on paper tenders, compared on net price like
everything else. The paper tender becomes `awarded`. Spec: *Sources and parsers → gnumner*
(contract-concluded parser). Research: the two sampled 323-Ա notices.

**Blocked by:** 06

**Status:** ready-for-agent

- [ ] The «Կնքված պայմանագրի մասին հայտարարություն» listing is swept with watermark rules. Only
      notices for paper tenders are written. Notices for ARMEPS or e-auction tenders are skipped,
      because their results come from PPCM and eauction (ADR 0004 ownership).
- [ ] A pure parser for template 323-Ա (`.docx`) yields, per lot: every bidder's name, net price,
      VAT and total, rejected bids with reasons, the winner, the contract price and the contract
      date.
- [ ] Rows write `public_tender_bids` and `awards` with `source = 'gnumner'`: net into the `*_net`
      columns and total into the gross ones. A non-VAT payer's empty VAT cell means net equals
      gross.
- [ ] The notice resolves through the resolution module. If it has no candidate or is ambiguous,
      it is an unmatched result. A later-appearing tender picks it up.
- [ ] The tender's status becomes `awarded` through *derive status*, with the gnumner contract
      notice as the owning source.
- [ ] Unreadable formats count as `unsupported_format`, with the same owner comment as ticket 06.
- [ ] Verified by hand on `de685221.docx` and `ca55aac0.docx` (research.md): parsed figures equal
      the documents.
- [ ] `competitor-prices` returns the paper tender's bidders, and a benchmark with too few
      comparables still says `insufficient_data`.
