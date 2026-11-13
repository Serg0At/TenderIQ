# 04 — Biddable lots get inferred codes at ingest

**What to build:** When a biddable tender is ingested, every lot whose source states no code (on
any channel, in practice paper) is coded in the background by the configured method, and the API
shows the inferred code beside the stated ones, never merged into them. A stated code arriving
later replaces the inferred one. A lot renamed in an amendment is coded again. An inferred code
never counts as an amendment. Matching, filters and relevance do **not** read inferred codes yet;
that is ticket 05. See `.scratch/cpv-inference/spec.md`, *Which lots are coded*, *Job and
timing* and *API*.

**Blocked by:** 02 — Candidates, the no-model method, and the backtest.

**Status:** done

- [x] A new job (name a constant; job ids hyphenated) codes one tender's candidate lots, on a
      queue where a slow model call cannot hold back alert delivery.
- [x] The normalizer queues it after saving a tender that is biddable; backfills and closed
      tenders are never queued.
- [x] The method (`model` | `nearest`) is a config value read in the one config file; ticket 03
      need not be done for `nearest` to work.
- [x] Each inferred code is written with its provenance. A lot that cannot be classified (none,
      low confidence, refusal, `rate_limited`, `ai_unavailable`) stays uncoded and is counted with
      its reason.
- [x] A throttled model call spends an attempt; on the last attempt the lots are recorded
      unclassified. Ingestion never fails because of this job.
- [x] A lot that gains a stated code loses its inferred code in the same write. A lot whose name
      changed in an amendment is re-coded. Nothing is re-coded when the classifier or the model
      changes.
- [x] The amendment fingerprint does not read the inferred column: re-coding never raises
      `version` or an alert.
- [x] Tender lots answer `inferredCpvCode` (with `cpvName`); the tender answers `inferredCpvCodes`
      beside `cpvCodes`, never merged. `docs/API_REFERENCE.md` documents both.
- [x] Verified by hand on the local database: a newly ingested biddable paper tender's lots get
      inferred codes with provenance; a closed tender's do not; re-running the job changes no
      `version`; the counts of coded and unclassified lots are reported.
- [x] End the report by telling the owner to restart the worker.

## Done — 2026-11-13

Verified on the local `tendra` database (the new column hand-`ALTER`ed in), against stored
files only: no source was fetched.

- **Where it is queued.** Not from the normalizer itself: no lot exists when a tender is
  saved. Lots are written in exactly one place, `AddendumService.recordDocuments`, by the
  document stage the normalizer queues (paper's `paper.documents`, ARMEPS's and e-auction's
  document jobs). That is where `cpv.infer` is queued, after the commit, when the set left a
  lot to code, the priority is not `BACKFILL` and the tender `isOpen` (biddable). Job id
  `cpv-{tenderId}-{sha256(storageKey)[0:12]}` (`names.js#inferCpvJobId`), like the ticket-25
  re-match: a retried document job reuses it, a new set gets its own.
- **Its own queue, `inference`** (`QUEUE.INFERENCE`, `JOB.INFER_CPV = 'cpv.infer'`,
  `workers/cpvInference.js`, concurrency 2), not ALERTS: the checklist extractor's model call
  already rides ALERTS, and a second one there would hold alert slots. The health sweep reads
  it through `queues`.
- **There is no UPDATE of `tender_lots.cpv_code` anywhere.** Every writer (the normalizer's
  paper documents, the document stage of every source, `documents:backfill`,
  `replayResultNotices`, the paper amendment notice) goes through
  `tender.repo.js#applyInvitationFacts`, which **deletes and re-inserts** a source's lots. So
  the CHECK could never trip there. The opposite would happen instead: every rewrite would
  silently drop the inferred code. Before the delete, it now reads the lots that were tried and
  carries code, reason and provenance onto the new row with the same `(lot, item)` key, **only
  when the name is unchanged (spacing and case aside) and the new row states no code.** A lot
  that now states one is inserted without the guess, in the same write. A renamed lot is
  inserted untried and counted in `lotsToCode`, which is what queues the job. The job's own
  write (`inferredCpv.repo.js#record`) repeats `cpv_code IS NULL AND inferred_cpv_at IS NULL`
  in the UPDATE, so a lot that gains a stated code mid-job is skipped, not refused by the CHECK.
- **Unclassified lots are counted in the database**: a new `inferred_cpv_unclassified` (reason:
  `none`, `low_confidence`, `refusal`, `invalid_code`, `rate_limited`, `ai_unavailable`,
  `internal_error`) is written with the method, classifier version and time and a null code.
  `inferred_cpv_at` set means "tried", and a tried lot is never tried again. Nothing re-codes on
  a classifier or model change. CHECK `tender_lots_inferred_cpv_unclassified_chk`: a reason only
  with a null code and full provenance, from that list. Also in `create_table.js`
  (`drop_table.js` needs nothing: the column goes with its table).
- **Method** is `CPV_INFERENCE.METHOD` (`CPV_INFERENCE_METHOD`, `nearest` | `model`, default
  `nearest`), in its own config block. `services/cpvCoding.service.js` runs it per distinct lot
  name and writes each outcome as it goes, so a retry resumes. A pick outside the candidates is
  refused as `invalid_code`, whatever made it. **`model` is not wired here**: until ticket 03
  adds it to `METHODS`, a `model` job fails with `UnrecoverableError` before touching a lot, so
  nothing is recorded under a method that never ran (checked). The model id recorded beside a
  `model` outcome is `AI.CPV_MODEL`, ticket 03's config.
- **The last attempt** records every untried lot under the thrown reason (`RATE_LIMITED` →
  `rate_limited`, `DEPENDENCY_UNAVAILABLE` → `ai_unavailable`, else `internal_error`) and
  rethrows, as the checklist extractor does. Checked with a throttle forced on a closed paper
  tender: attempt 1/3 recorded nothing, 3/3 recorded `rate_limited` on all 5 lots. Those lots
  were reset afterwards.
- **The amendment fingerprint** (`tender.repo.js#fieldHash`) reads only observation fields,
  never `tender_lots`, and the addendum check compares file manifests. The job writes only
  `inferred_cpv_*`, so it cannot move `version`.
- **API**: each lot has `inferredCpvCode`, and `cpvName` names whichever code the lot shows
  (joined on `coalesce(cpv_code, inferred_cpv_code)`). The tender has `inferredCpvCodes` (sorted,
  distinct) and `inferredCpvNames` beside `cpvCodes`/`cpvNames`, never merged.
  `findDetail` still returns `cpv_code` as the stated code alone, which is all the matcher and
  the intelligence callers read. Documented in `docs/API_REFERENCE.md` under *Inferred CPV codes*.
  Only `tender.service.js`, `tender.repo.js` and the two new files mention the inferred column:
  no matcher, filter, relevance or intelligence code reads it.

### By hand

- **Backfill**: `paper.documents` at `PRIORITY.BACKFILL` for a biddable tender
  (`r5vj5vsi…`, 5 lots to code) queued nothing and tried no lot.
- **Closed**: the same at `LIVE` for a closed paper tender (`ujvieymo…`, 5 uncoded lots)
  queued nothing and tried no lot.
- **Live**: the eight biddable paper tenders at `LIVE`. Six queued one `cpv.infer` each,
  priority 2. Two could not rebuild their document job, because the stored listing page it
  reads is missing from storage (`NoSuchKey`, `lzrgizwq…`, `oe26gzp3…`; this predates this
  ticket and lies outside it). A worker on `inference` alone drained them. Provenance on every
  tried lot: `nearest`, classifier `2026-11-11`, the time, no model id. No `version` moved.
- **Re-run**: the document job again on a coded tender (`x7gyfmd6…`, v2) re-inserted all 10
  lots with new ids, kept every code and reason, queued nothing. The job run again found 0 lots.
  Version still 2.
- **Stated code and rename** (rolled-back transaction on the real writer): lot 2, inferred
  `33141212`, given a stated code → inserted with the stated code and no inferred one; lot 3
  renamed → inserted untried, `lotsToCode` 1; unchanged lots kept their attempt. The job's
  write on the now-stated lot touched 0 rows; a direct UPDATE was refused by
  `tender_lots_inferred_cpv_stated_chk`.

### Counts after the run (`nearest`, paper)

**19 lots tried on 6 biddable paper tenders: 3 coded, 16 unclassified (all `none`).** 3 paper
lots and 17 ARMEPS lots on biddable tenders are still untried; their document sets were written
before this existed, and the next live set codes them. E-auction has no uncoded biddable lot.

The three codes show why the gate exists: «Կենտրոնացված ջեռուցման կաթսաների վերանորոգում» →
`44621170`; «Հելիում գազ» → `33141212` «բժշկական այլ նյութեր»; «Ազոտ» → `24441100`
«զանազան պարարտանյութեր» (nitrogen gas coded as fertiliser). `nearest` copies the nearest
buyer's code, mistakes included. Readers ignore inferred codes until ticket 05, and alerts until
the gate (ticket 06).

