# 11 — PPCM supplies ՀՎՀՀ for e-auction bidders

**What to build:** e-auction bidders gain their ՀՎՀՀ from PPCM, so the same company is recognised
across all three submission channels. That happens without any name matching and without PPCM
touching e-auction prices, ranks or statuses. ADR 0004: *For e-auctions PPCM adds only the bidder's
ՀՎՀՀ*.

**Blocked by:** 10

**Status:** ready-for-agent

- [ ] For awarded e-auction tenders with bidders lacking a ՀՎՀՀ, PPCM rows are fetched by
      procedure code.
- [ ] A ՀՎՀՀ attaches to a party only when tender, lot number and **exact** net price all match
      one ledger row. Anything else attaches nothing and is counted.
- [ ] PPCM writes no `public_tender_bids` or `awards` rows for e-auction tenders and never changes
      status, rank or rejection there.
- [ ] Party resolution matches by ՀՎՀՀ first, by per-source id second, so a PPCM or gnumner bidder
      with a known ՀՎՀՀ reuses the existing party.
- [ ] If two parties end up with the same ՀՎՀՀ, that is reported, not auto-merged. Record the
      count.
- [ ] Verified on the 12 e-auction tenders found in PPCM on 2026-10-18 (research.md): the number
      of parties that gained a ՀՎՀՀ, and zero price or status changes.
