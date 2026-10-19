# 13 — `sources:verify`: check the merge rules on real data

**What to build:** The operator runs one command and sees, per source, how many results attached
and how many did not, by reason, plus the PPCM-vs-ledger comparison. This is the stand-in for a test
suite: it prints numbers and asserts nothing. Spec: *Verification script*, *Testing Decisions*.

**Blocked by:** 08, 10

**Status:** ready-for-agent

- [ ] `npm run sources:verify`, with a description entry in `package.json` like
      `relevance:backtest`, and `--from` / `--to` options for the window.
- [ ] Per source (`eauction`, `armeps`, `gnumner`, `ppcm`): tenders created and linked, and
      unmatched results by reason (`no_candidate`, `ambiguous`, `no_code`, `unsupported_format`),
      with `unsupported_format` broken down by file extension.
- [ ] Tenders per submission channel and status.
- [ ] The PPCM-vs-ledger comparison on e-auction tenders present in both: rows equal on net price,
      contract price equal to gross award, rejection-flag disagreements, and parties that gained a
      ՀՎՀՀ.
- [ ] gnumner's e-auction notices counted against e-auction tenders held, as an independent
      coverage check.
- [ ] It reads through repositories only. No Knex in the script.
- [ ] Run once on the local DB, with the output pasted here. The `unsupported_format` breakdown
      is what decides whether a `.doc` / `.rar` converter is worth adding, so raise that with the
      owner.
