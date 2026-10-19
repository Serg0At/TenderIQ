# 10 — PPCM results for ARMEPS tenders

**What to build:** A supplier sees every bidder's price on a finished ARMEPS tender, and a bid they
submitted on one is reconciled into won, lost or not_found. A tender PPCM has not reported yet
stays unresolved, never lost. Spec: *Sources and parsers → PPCM*. Research: *Verification against
our e-auction ledger*.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] A `ppcm` adapter: the client loads the reports page for a session cookie, then `POST`s
      report requests. `values` is a list of `{paramId, value}` with a **plain string** value,
      and `page` is `{index, size}`. Report and parameter ids live in the sources config.
- [ ] A per-tender results refresh, scheduled like `tender.refresh`, queries the organized
      procedures report by procedure code for ARMEPS tenders past deadline and unresolved, within
      a refresh window.
- [ ] Each returned row resolves through the resolution module: our code, the `armeps` channel,
      and announcement and opening dates. A mismatch or ambiguity is an unmatched result.
- [ ] Rows write `public_tender_bids` and `awards` with `source = 'ppcm'`.
      `participant_total_price` is **net**, and `contract_price` is the **gross** award.
      Bidder ՀՎՀՀ lands on the party.
- [ ] The tender becomes `awarded` through *derive status*, with PPCM as the owning source for
      ARMEPS.
- [ ] `bids.reconcile` resolves ARMEPS bids from these rows with no change to its rules.
      `not_found` stays retryable.
- [ ] Raw JSON responses are stored. Politeness is no looser than eauction's, and a session
      expiry is renewed, not retried blindly.
- [ ] Verified by hand on three ARMEPS tenders (including an open tender): the stored rows equal
      PPCM's report rows. Record them here.
