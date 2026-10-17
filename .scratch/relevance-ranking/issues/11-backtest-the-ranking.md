# 11 — Measure whether the ranking is any good

**What to build:** A script that answers, with numbers, the question the whole feature rests on:
if we had ranked for this supplier back then, would their real bids have been near the top?

The method is a backtest against the public ledger, which records what hundreds of real suppliers
actually bid on. Pick a supplier and a cut-off date. Hide everything they did after it. Rank the
tenders that were biddable on that date using only their earlier history. Then look at where the
tenders they really bid on landed in that ranking — top ten, top page, or buried.

Run across many suppliers, that produces a single honest figure for the feature, and the same
harness sweeps the recency window: run it at 6, 12 and 24 months of full weight and keep whichever
ranks real bids highest. That is the measurement ticket 06 deliberately deferred rather than
guessing.

It is a script under `src/scripts/`, beside the prospect exporter — run by hand, prints numbers,
asserts nothing, and is not a test. The project has no test runner and this ticket does not add
one. Its results belong in the spec folder as a short findings note, because the next person to
change a weight needs to know what the current weights scored.

If the ranking performs badly, that is a successful outcome for this ticket. The weights change,
or the feature is reconsidered, before a customer ever sees it.

**Blocked by:** 06, 07, 10.

**Status:** ready-for-agent

- [ ] The script replays the ranking for a supplier at a past date using only data available
      before that date — no leakage of later bids, awards or pursuits into the signals.
- [ ] It reports where that supplier's real subsequent bids landed in the ranking, as a position
      distribution rather than a single pass/fail.
- [ ] It runs across many suppliers and reports an aggregate, so one unusual company cannot carry
      the verdict.
- [ ] It sweeps the recency-window configuration and reports the ranking quality at each setting.
- [ ] It reuses the production ranking function unchanged — a second copy of the scoring rule
      would measure something that is not shipped.
- [ ] Suppliers with too little history are reported separately rather than averaged in, since
      their ranking was never going to be meaningful.
- [ ] The findings, including the chosen recency window and the weights as they stood, are written
      into the feature folder.
- [ ] If the results are poor, that is stated plainly and the weights are revised before the
      feature is announced.
