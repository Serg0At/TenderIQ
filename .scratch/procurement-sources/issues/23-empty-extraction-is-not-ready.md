# 23 — An extraction that keeps no items is a failure, not an empty checklist

**What to build:** A supplier never sees a `ready` checklist with no AI items, which reads as
"nothing is required for this tender", the most dangerous answer this feature could give (CLAUDE.md).
When the model returns nothing, or every item it returns is dropped by `verifyEvidence`, the
checklist says `failed` with a reason and can be generated again. Found in ticket 21 (row 7 of its
table). The behaviour predates that ticket and sits in `ChecklistExtractionService.extract`.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Two reasons, because they have different repairs:
  - `no_items`: the model returned an empty list, so the prompt or the document is the question;
  - `no_verifiable_items`: the model returned items, but none quoted the document, so evidence
    verification is the question.

  Record how many items were returned and dropped in the log line.
- [ ] A failed empty extraction **does not replace** the previous AI items or the stored
      `document_hash`. A checklist that was `ready` with real items keeps them, and the failure is
      reported on the row. This is the same rule as ticket 21's failed `force`.
- [ ] Manual items are untouched and stay visible beside the failure.
- [ ] Ticket 21's "an extraction that kept no items is never current" check still holds, and is
      now mostly unreachable. Keep it as the guard for rows stored before this fix.
- [ ] Rows already stored as `ready` with zero AI items are listed (locally, and noted for Neon at
      deploy). A plain regenerate re-runs them through ticket 21's rule; say so here.
- [ ] Both reasons are listed under GET checklist in `docs/API_REFERENCE.md`.
- [ ] Verified with a stubbed extract (no AI access needed): an empty answer → `failed` /
      `no_items`; two items with fabricated evidence → `failed` / `no_verifiable_items`, previous
      items intact; one valid item among fabricated ones → `ready` with that one item.
