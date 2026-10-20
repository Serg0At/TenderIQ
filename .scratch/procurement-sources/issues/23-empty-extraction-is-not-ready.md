# 23 — An extraction that keeps no items is a failure, not an empty checklist

**What to build:** A supplier never sees a `ready` checklist with no AI items, which reads as
"nothing is required for this tender", the most dangerous answer this feature could give (CLAUDE.md).
When the model returns nothing, or every item it returns is dropped by `verifyEvidence`, the
checklist says `failed` with a reason and can be generated again. Found in ticket 21 (row 7 of its
table). The behaviour predates that ticket and sits in `ChecklistExtractionService.extract`.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] Two reasons, because they have different repairs:
  - `no_items`: the model returned an empty list, so the prompt or the document is the question;
  - `no_verifiable_items`: the model returned items, but none quoted the document, so evidence
    verification is the question.

  Record how many items were returned and dropped in the log line.
- [x] A failed empty extraction **does not replace** the previous AI items or the stored
      `document_hash`. A checklist that was `ready` with real items keeps them, and the failure is
      reported on the row. This is the same rule as ticket 21's failed `force`.
- [x] Manual items are untouched and stay visible beside the failure.
- [x] Ticket 21's "an extraction that kept no items is never current" check still holds, and is
      now mostly unreachable. Keep it as the guard for rows stored before this fix.
- [x] Rows already stored as `ready` with zero AI items are listed (locally, and noted for Neon at
      deploy). A plain regenerate re-runs them through ticket 21's rule; say so here.
- [x] Both reasons are listed under GET checklist in `docs/API_REFERENCE.md`.
- [x] Verified with a stubbed extract (no AI access needed): an empty answer → `failed` /
      `no_items`; two items with fabricated evidence → `failed` / `no_verifiable_items`, previous
      items intact; one valid item among fabricated ones → `ready` with that one item.

## Results (2026-10-20)

**How it was verified.** The model was stubbed one level below `extract`, at the adapter's
`ai.completeStructuredStreaming`, so `extract`'s own Joi validation, `verifyEvidence` and the new
check all ran for real. No AI request was made.
- Each run went through the real `ChecklistService.generate` and then the handler, with `force`.
- The subject was ticket 16's repro checklist `avfj7wgoditx8c37o8zo3yzs`, over its real 144,542-character
  invitation, with one manual item present.
- "Valid" evidence was a phrase cut from that text. "Fabricated" evidence was English sentences that
  appear nowhere in it.

| Model answer | Before | After |
|---|---|---|
| Two items with real evidence | `ready`, 2 AI items | `ready`, 2 AI items |
| Empty list | `ready`, **0 AI items; previous items deleted** | `failed` / `no_items`; previous 2 items and hash intact |
| Two items, both fabricated | `ready`, **0 AI items; previous items deleted** | `failed` / `no_verifiable_items`; previous 2 items and hash intact |
| One valid among two fabricated | `ready`, 1 item | `ready`, 1 item |

The manual item kept its id in every row. Log lines from the run:
`kept no items (no_items): 0 returned, 0 dropped as unverifiable, quality=unusable` and
`kept no items (no_verifiable_items): 2 returned, 2 dropped as unverifiable, quality=good`. Each is
followed by a worker line that names the tracked tender, for example
`checklist for xc3jbzh2c9idopep7fm883j5 not extracted: failed (no_items)`.

**The change.** `ChecklistExtractionService.extract` returns
`{ status: 'failed', reason, documentHash }` when `verifyEvidence` keeps nothing. The reason is
`no_items` if the model returned none, and `no_verifiable_items` if it returned some and all were
dropped. A `failed` result is recorded with `markStatus`, which never touches items or
`document_hash`, so a checklist that was `ready` keeps its real items beside the failure.

**Prompt rule 8 is left as it is, deliberately.** It tells the model an empty answer is valid,
and for the model it is, because padding is worse. The code now decides what the supplier is
shown: "nothing here" from the model means the document or the prompt needs a look, not that the
tender asks for nothing. Changing the prompt would need an eval run. A comment at the check
records this.

**Ticket 21's guard is kept** (`isCurrent` requires at least one AI item), and its comment now says
what it is for: rows stored as an empty `ready` before this fix, and a checklist whose AI items a
user deleted one by one. Verified on a recreated legacy row: `ready`, hash of this exact text,
0 AI items. A plain regenerate made 1 model call instead of answering `unchanged`, and the
stubbed empty answer then recorded `failed` / `no_items`.

**Rows stored as `ready` with zero AI items.** There are 0 locally, before and after; the only
organization is the repro. **Neon, at deploy:** list them with

```sql
select c.id from checklists c where c.status = 'ready' and not exists
  (select 1 from checklist_items i where i.checklist_id = c.id and i.source = 'ai');
```

There is nothing to migrate. Each one re-extracts on its next plain generate through ticket 21's
rule, and if the model again finds nothing it now lands on `failed`.

**Known, not changed.**
- After a forced run fails with `no_items` on an unchanged document, a plain regenerate brings
  back `ready` with the earlier items and no model call. That is ticket 21's documented rule for
  a failed `force`, so the failure is no longer visible after that regenerate.
- If the document changed and the new extraction fails, the row shows `failed` beside items from
  the old document, and `generatedAt` is the only sign they are stale. That predates this ticket.
- `documentQuality` reaches only the log; `notes` is not kept anywhere.

**Not tested.** A real model answer: every answer here was stubbed. Ticket 22 covers it.
