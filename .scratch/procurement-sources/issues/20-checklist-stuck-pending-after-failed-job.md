# 20 — A checklist whose job failed does not stay "pending" forever

**What to build:** A supplier whose checklist extraction failed for good (the model was
unreachable, the gateway refused the request) sees `failed` with a reason and can press generate
again, not a checklist that says `pending` forever and answers every later generate with 409.
Found in ticket 16.

**Blocked by:** None — can start immediately.

**Status:** needs-triage

`ChecklistService.generate` marks the checklist `pending` before it enqueues. When the handler
throws (e.g. `DEPENDENCY_UNAVAILABLE` from the AI adapter), BullMQ retries, and after the last attempt
the job sits in the failed set — but nothing moves the row off `pending`. Observed in ticket 16:
an OpenRouter 402 ("requires more credits") threw out of `handleChecklistExtract` with the row
untouched. After that, only `force: true` gets past the 409, and no client is told to send it.

- [ ] Reproduce on the local DB: make the model call fail, let the job exhaust its attempts, and
      record the checklist row's status.
- [ ] On the final failed attempt, the checklist is marked `failed` with a reason, so a plain generate
      re-runs it. Decide where this goes: a `failed` listener in the worker or a catch in the handler
      that rethrows only while attempts remain. Record which one was chosen and why.
- [ ] A transient failure that a retry will fix still leaves the row `pending` — the client must not
      see `failed` between attempts.
