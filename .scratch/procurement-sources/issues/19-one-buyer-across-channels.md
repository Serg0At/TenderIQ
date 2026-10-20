# 19 — One buyer across submission channels, joined by ՀՎՀՀ

**What to build:** A buyer that procures by e-auction and through ARMEPS is one party, so its buyer
profile (spend, suppliers, prices) covers both channels instead of splitting in two. Found in ticket
05: 25 of the first 31 ARMEPS buyers already exist as e-auction parties under the same name.
Decided 2026-10-20: buyers are joined **by ՀՎՀՀ only, never by name**. That is the same reason a
supplier identity is never matched on name: scraped Armenian legal names quote inconsistently, and
a wrong merge is invisible.

**Blocked by:** 10, 11

**Status:** ready-for-agent

- [ ] An ARMEPS buyer gets its ՀՎՀՀ from a structural source, never a name lookup:
  - from its stored invitation documents, if they carry it the way e-auction invitations do
    (`invitation.parser.js` already reads it there; check a sample first and record the hit rate);
  - otherwise from PPCM, when a PPCM result has attached to that buyer's tender (ticket 10).
    The tender match is the join, and the PPCM authority's ՀՎՀՀ then belongs to that tender's
    buyer.
- [ ] Party resolution matches by ՀՎՀՀ first, by per-source id second (ticket 11 builds this for
      bidders; buyers use the same path).
- [ ] Existing duplicates are merged where both parties hold the same ՀՎՀՀ: tenders and every other
      reference move to one party, then the other is removed, in one transaction per pair.
      Record the count of merged pairs.
- [ ] A buyer with no ՀՎՀՀ on either side stays split. It is counted, not merged by name. Record
      how many of the 25 remain split and why.
- [ ] Buyer profiles and buyer-specific benchmarks read the merged party. Check one merged buyer's
      profile before and after, and record it.
- [ ] Two parties holding one ՀՎՀՀ with clearly different names are reported, not merged blindly.
      Record what was found.
