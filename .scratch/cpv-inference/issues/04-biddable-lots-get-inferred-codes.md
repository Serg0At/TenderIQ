# 04 — Biddable lots get inferred codes at ingest

**What to build:** When a biddable tender is ingested, every lot whose source states no code (on
any channel, in practice paper) is coded in the background by the configured method, and the API
shows the inferred code beside the stated ones, never merged into them. A stated code arriving
later replaces the inferred one. A lot renamed in an amendment is coded again. An inferred code
never counts as an amendment. Matching, filters and relevance do **not** read inferred codes yet;
that is ticket 05. See `.scratch/cpv-inference/spec.md`, *Which lots are coded*, *Job and
timing* and *API*.

**Blocked by:** 02 — Candidates, the no-model method, and the backtest.

**Status:** ready-for-agent

- [ ] A new job (name a constant; job ids hyphenated) codes one tender's candidate lots, on a
      queue where a slow model call cannot hold back alert delivery.
- [ ] The normalizer queues it after saving a tender that is biddable; backfills and closed
      tenders are never queued.
- [ ] The method (`model` | `nearest`) is a config value read in the one config file; ticket 03
      need not be done for `nearest` to work.
- [ ] Each inferred code is written with its provenance. A lot that cannot be classified (none,
      low confidence, refusal, `rate_limited`, `ai_unavailable`) stays uncoded and is counted with
      its reason.
- [ ] A throttled model call spends an attempt; on the last attempt the lots are recorded
      unclassified. Ingestion never fails because of this job.
- [ ] A lot that gains a stated code loses its inferred code in the same write. A lot whose name
      changed in an amendment is re-coded. Nothing is re-coded when the classifier or the model
      changes.
- [ ] The amendment fingerprint does not read the inferred column: re-coding never raises
      `version` or an alert.
- [ ] Tender lots answer `inferredCpvCode` (with `cpvName`); the tender answers `inferredCpvCodes`
      beside `cpvCodes`, never merged. `docs/API_REFERENCE.md` documents both.
- [ ] Verified by hand on the local database: a newly ingested biddable paper tender's lots get
      inferred codes with provenance; a closed tender's do not; re-running the job changes no
      `version`; the counts of coded and unclassified lots are reported.
- [ ] End the report by telling the owner to restart the worker.
