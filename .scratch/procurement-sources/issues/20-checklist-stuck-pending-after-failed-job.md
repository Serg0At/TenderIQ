# 20 — A checklist whose job failed does not stay "pending" forever

**What to build:** A supplier whose checklist extraction failed for good (the model was
unreachable, the gateway refused the request) sees `failed` with a reason and can press generate
again, not a checklist that says `pending` forever and answers every later generate with 409.
Found in ticket 16.

**Blocked by:** None — can start immediately.

**Status:** done

**Triage (2026-10-20):** confirmed in code. `checklist.repo.js` inserts the row as `pending`.
`aiExtractor.js` writes `unavailable`, `failed` or `ready` only on the paths that *return*; a
throw leaves the row as it was. Two decisions settle the open question:

- **The handler marks the final failure, not the generic `failed` listener.** The listener in
  `workers/index.js` serves every queue, and a checklist-specific DB write there spreads business
  logic into process wiring. The handler already knows the checklist id. It catches, and on the
  last attempt (`job.attemptsMade + 1 >= job.opts.attempts`) marks `failed` with a reason, then
  rethrows so BullMQ still records the failure. A rate-limited model call keeps the existing
  `moveToDelayed` + `DelayedError` path and never counts as the last attempt.
- **A `pending` row with no live job behind it is also re-runnable.** A job can be lost without
  ever failing (a removed job, a flushed Redis, a crash before `add`), and the handler then never
  runs to mark anything. So `generate` treats `pending` as in flight only while the queue still
  holds its job as waiting, delayed or active; otherwise it re-runs as for `failed`. This replaces
  the need for a client to send `force`.

`ChecklistService.generate` marks the checklist `pending` before it enqueues. When the handler
throws (e.g. `DEPENDENCY_UNAVAILABLE` from the AI adapter), BullMQ retries, and after the last attempt
the job sits in the failed set — but nothing moves the row off `pending`. Observed in ticket 16:
an OpenRouter 402 ("requires more credits") threw out of `handleChecklistExtract` with the row
untouched. After that, only `force: true` gets past the 409, and no client is told to send it.

- [x] Reproduce on the local DB: make the model call fail, let the job exhaust its attempts, and
      record the checklist row's status.
- [x] On the final failed attempt, the checklist is marked `failed` with a reason, so a plain generate
      re-runs it. Decide where this goes: a `failed` listener in the worker or a catch in the handler
      that rethrows only while attempts remain. Record which one was chosen and why.
- [x] A transient failure that a retry will fix still leaves the row `pending` — the client must not
      see `failed` between attempts.
- [x] A `pending` row whose job is gone (remove the job by hand to reproduce) is re-run by a plain
      generate, while a `pending` row whose job is still waiting or active still answers 409.
- [x] The new failure reason is listed with the others under GET checklist in
      `docs/API_REFERENCE.md`.
- [x] Any row stuck `pending` locally today (ticket 16's repro left at least one) is listed, and
      shown to be re-runnable after the fix.

## Results (2026-10-20)

**How the model failure was reproduced without a real AI request.**
- `ANTHROPIC_BASE_URL=http://127.0.0.1:9`, a port nothing listens on: every call fails with
  "Connection error", the adapter throws `DEPENDENCY_UNAVAILABLE`, and nothing leaves the machine.
- The job went through the real `ChecklistService.generate`, then moved onto an empty scratch
  queue, which ran it through the real `processMatch` dispatcher with production's retry options:
  5 attempts, exponential backoff with the base shortened to 200 ms. Unrelated ALERTS jobs were
  not touched.
- The subject was ticket 16's repro checklist `avfj7wgoditx8c37o8zo3yzs` (tracked tender
  `xc3jbzh2c9idopep7fm883j5`).

**Before the fix.** All 5 attempts threw "The AI service is unavailable.", and the job sat in the
failed set with `attemptsMade` 5. The row stayed `{ status: 'pending', failure_reason: null }`,
and a plain generate answered `409 CONFLICT`.

**The final attempt is marked in the handler, as triaged.**
- `handleChecklistExtract` catches, and on the last attempt (`attemptsMade + 1 >=
  opts.attempts`) marks the checklist `failed`, then rethrows so BullMQ still records the
  failure.
- The reason comes from the adapter's error code: `ai_unavailable` for `DEPENDENCY_UNAVAILABLE`,
  `rate_limited` for `RATE_LIMITED`, anything else `internal_error`.
- A failed write of that status is logged and swallowed, so the job's own error is the one
  rethrown.
- The extraction body moved into `extractInto` so that a single catch covers every throw after
  the row exists.

**After the fix.**

| Scenario | Row / answer |
|---|---|
| Model unreachable, attempts 1–4 | `pending` |
| Model unreachable, attempt 5 | `failed` / `ai_unavailable`; job failed |
| Plain generate after that | 202, re-queued |
| Transient: attempt 1 throws, attempt 2 answers | `pending` after 1, then attempt 2's own result |
| `RATE_LIMITED`, attempt 4/5 → 5/5 | unchanged → `failed` / `rate_limited` |
| Plain `Error`, attempt 4/5 → 5/5 | unchanged → `failed` / `internal_error` |
| `pending` row, job removed by hand | plain generate re-runs (202) |
| Job still queued (prioritized) | 409 |
| `force: true` while the job is queued | 409 |
| Row already `failed`, job still queued | 409 |

**Where this differs from the triage, on two points.**

1. **The 409 depends on the job, never the row.** The triage kept the rule "`pending` and job live
   → 409". Review found the reverse window: a job that has just written `failed` or `ready` is still
   `active` for a moment, and a generate in that window would mark the row pending and answer 202,
   while its `add` under the still-taken id did nothing. So `generate` now answers 409 exactly
   while the job is live (`waiting`, `prioritized`, `delayed`, `active` or `waiting-children`),
   whatever the row says, and `force` included. `force` keeps its documented meaning, re-reading
   an unchanged document. It no longer needs to escape a stuck `pending`, because nothing gets
   stuck now. `prioritized` is on the list because BullMQ 6 gives prioritized jobs their own state,
   and every checklist job is prioritized.
2. **A throttle spends an attempt; it is not parked with `moveToDelayed`.** The triage said the
   throttle "keeps the existing `moveToDelayed` + `DelayedError` path". That path does not exist
   for checklist jobs: only `documents.js` and `gnumner.js` have it, `processMatch` does not pass
   the token, and the AI adapter carries no retry-after. Adding it would bring this bug back. A
   `DelayedError` never increments `attemptsMade`, so a quota that does not reset would loop
   delayed → active → delayed outside the attempt budget, and every one of those states is live:
   the row stuck `pending` and every generate a 409. This is recorded in CLAUDE.md's AI layer
   section as the one exception to ingestion's rule.

**Rows stuck `pending` locally.** There were none before this ticket: ticket 16's thrown runs
landed on a row that was already `unavailable`. The reproduction created one,
`avfj7wgoditx8c37o8zo3yzs` with no job behind it, and after the fix a plain generate re-ran it.
Neon was not checked. After deploy, any such row there re-runs on its next generate, with no
manual step.

**Documented.** GET checklist in `docs/API_REFERENCE.md` lists `ai_unavailable`, `rate_limited` and
`internal_error`. It also says the row stays `pending` between retries, and that 409 depends on
the job.

**Found, not fixed.** The handler's "already current — not re-extracting" skip runs *after*
`ChecklistExtractionService.extract`, which has already called the model and been charged for it.
`generate` also always leaves the row `pending`, so `checklist.status === 'ready'` never holds
there and the skip can never fire. That wants its own ticket.
