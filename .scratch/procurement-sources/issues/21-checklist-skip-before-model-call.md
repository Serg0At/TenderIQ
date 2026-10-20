# 21 — An unchanged document is not sent to the model again

**What to build:** Regenerating a checklist whose invitation has not changed returns the existing
items without a model call. Today that call is made and paid for, and its answer is thrown away.
This matters most for the full-invitation Opus calls `docs/AI_COST_MODEL.md` prices. Found in
ticket 20.

**Blocked by:** None — can start immediately.

**Status:** done

As ticket 20 reports, the handler's "already current — not re-extracting" skip runs **after**
`ChecklistExtractionService.extract`, which has already called the model. It also tests
`checklist.status === 'ready'`, but `generate` always sets the row to `pending` before enqueueing,
so the condition never holds and the skip never fires.

- [x] Confirm both halves first, by reading the code and with a stubbed extract that counts calls:
      the call happens before the skip, and the skip never fires. Record it.
- [x] Decide "is this document already extracted" **before** any model call, from what is stored:
      the checklist's `document_hash` against the hash of the text about to be sent. The
      checklist's current status is not the test, because `generate` has already moved it.
- [x] On an unchanged document without `force`, the row returns to `ready` with its existing items
      and no model call is made. With `force`, it re-extracts, as documented.
- [x] Manual items are untouched either way (`replaceItems` deletes only `source = 'ai'`).
- [x] Verified with a stubbed extract (no AI access needed): unchanged → 0 calls, `ready`, same
      items; changed → 1 call; `force` → 1 call. Record the counts.
- [x] `docs/API_REFERENCE.md` says what a regenerate of an unchanged document returns.

## Results (2026-10-20)

**How it was verified.**
- `ChecklistExtractionService.extract` was replaced by a stub that counts its calls and returns
  two items quoting the real invitation text. No AI request was made.
- Each regenerate went through the real `ChecklistService.generate`; its job was taken off the
  ALERTS queue and its payload run through `handleChecklistExtract`.
- Subject: ticket 16's repro checklist `avfj7wgoditx8c37o8zo3yzs` (tracked tender
  `xc3jbzh2c9idopep7fm883j5`, a real 144,542-character invitation). It held one manual item
  throughout.
- "Changed document" was simulated by setting the stored `document_hash` to the hash of another
  text, which is exactly what the decision reads.

**Both halves confirmed before the fix.** The unchanged regenerate called the model (+1), and its
answer replaced the items with new ids. The skip never fired, because `generate` had already set
the row to `pending`, so `status === 'ready'` never held there, and the check ran after
`extract` anyway.

**Model calls per regenerate:**

| Scenario | Before | After | After: row and items |
|---|---|---|---|
| First generate | 1 | 1 | `ready`, 2 AI items |
| Regenerate, document unchanged | **1** | **0** | `ready`, same item ids, result `unchanged` |
| Regenerate with `force` | 1 | 1 | `ready`, new items |
| Regenerate, document changed | 1 | 1 | `ready`, new items |
| Forced regenerate the model refuses | — | 1 | `failed`; items and hash unchanged |
| Plain regenerate after that failure | — | 0 | `ready`, the items from before the forced run |
| Forced run that keeps no items | — | 1 | `ready`, 0 AI items |
| Plain regenerate of that empty checklist | — | 1 | re-extracted |

The manual item kept its id in every row of the table.

**The change.**
- `ChecklistExtractionService.isCurrent({ documentHash, aiItemCount }, text)` decides before
  any model call. `document_hash` is written only by `replaceItems`, in the same transaction as
  the AI items, so a matching hash means those items were read from this text. `markStatus`
  never touches the hash or the items, so a failed run since then does not break that.
- The hash has one definition, `documentHash`, used both by `extract` and by that check.
- On a match without `force`, the row goes back to `ready` through `markStatus`, which leaves
  `generated_at` and `model` as they were, and no model call is made.
- `checklist.repo.js#countAiItems` supplies the item count.

**Beyond the ticket, from review: an extraction that kept no items is never current.** Without
this, an empty `ready` checklist (every item dropped by `verifyEvidence`) would have answered
`unchanged` to every plain regenerate. That would make "nothing is required" permanent for
anyone who does not know to send `force`.

**Known limit, documented.** A plain regenerate after a *failed* `force` brings back the items
from before it. Nothing stores which prompt version produced the items, so `ready` cannot tell
old-prompt items from new ones. Folding a prompt version into the stored hash would; it is not
done here.

**Found, not fixed.** An extraction that keeps zero items is stored as `status: 'ready'` with an
empty list (row 7 of the table). CLAUDE.md calls an empty list "the most dangerous thing this
feature could tell a supplier", and the `unavailable` path exists to avoid it. This is
pre-existing in `ChecklistExtractionService.extract` and wants its own ticket. It probably
belongs as `failed` / `no_verifiable_items`.

**Not tested.** A real model answer: every extraction here was stubbed.
