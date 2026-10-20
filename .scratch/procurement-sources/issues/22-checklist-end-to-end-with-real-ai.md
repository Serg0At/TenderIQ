# 22 — The AI checklist, end to end, against a real model

**What to build:** Proof that a supplier pressing *generate* gets a real checklist through the real
path (HTTP → queue → running worker → model → stored items), and that real provider failures land
where tickets 16 and 20 say they do. Tickets 16 and 20 closed their code with every model call
simulated, because there was no AI access. This ticket holds everything they could not test, so it
is not lost in their "Not tested" notes.

**Blocked by:** 16, 20, 21, 23 (and AI access: OpenRouter credits, `.env` `AI_MODEL=anthropic/claude-opus-5`)

**Status:** ready-for-human

It needs the owner: credits cost money, and some checks provoke real provider errors.

- [ ] **Ticket 16's open box.** Through `POST /tracked-tenders/:id/checklist/generate` with
      `npm run worker` running: the repro tender (tid 47818, checklist `avfj7wgoditx8c37o8zo3yzs`)
      produces items, and every item's evidence passes `verifyEvidence`. Record the item count and
      one evidence span here and in ticket 16, then set ticket 16 to `done`.
- [ ] After the model answers: items are saved, low-confidence ones carry `needs_review`, and a
      second generate of the unchanged document makes no model call (ticket 21). Record the
      `cache_read_input_tokens` of the second real call, if any, to confirm the cached prefix.
- [ ] **Real provider failures** (ticket 20 saw only fakes):
  - an invalid key → 401 → `failed` / `ai_unavailable` after the last attempt;
  - a real 429 from rapid calls, if it can be provoked cheaply → `rate_limited`, otherwise
    write "not provoked" here.

  The row stays `pending` between attempts in both.
- [ ] **A transient failure followed by real items:** the gateway is unreachable for the first
      attempt only, then real items arrive.
- [ ] **The races, live:** two generate requests at the same moment (one 202, one 409), and a
      generate while the job is `active`, not only queued.
- [ ] Delete ticket 16's throwaway organization and user (`Ticket 16 repro`,
      `ticket16-repro@example.invalid`, org `bida9tbed1qwbc336m0t8y1n`).
- [ ] **Neon, at deploy:** count checklists stored `unavailable` / `no_document` since `6f22fab`.
      They re-run on their next generate. Note whether any customer should be told.
