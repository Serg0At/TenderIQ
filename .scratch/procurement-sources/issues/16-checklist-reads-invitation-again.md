# 16 — The AI checklist reads the invitation text again

**What to build:** A supplier who generates a checklist for a tender with a stored invitation gets
items extracted from that invitation, not `status: 'unavailable'`. This is a regression fix, found
in passing during ticket 05.

**Blocked by:** None — can start immediately.

**Status:** ready-for-human

Since `6f22fab` (per-tender file list and single-file downloads), `tenders.findDetail` selects
`tender_documents` as `id, kind, url, parsed, manifest`, without `storage_key`. The extractor's
`loadInvitationText` takes the invitation row from `findDetail` and reads `storage_key` from it, so
it always sees `undefined` and reports no text. Every checklist generated since then answers
"unavailable" no matter what is stored, which looks like the common "no document" path and so
raises no alarm.

- [x] Confirm the regression first: on the local DB, generate a checklist for a tender that has a
      stored invitation `.txt`, and record that it currently comes back unavailable.
- [x] The extractor gets the invitation's storage key from a repository method meant for it (for
      example, the invitation document of a tender), not from `findDetail`. `findDetail` serves
      the API, and an internal storage key must not be added to the detail response just to feed
      a worker.
- [x] ARMEPS invitations (ticket 05, `kind` and archive shape may differ from e-auction's) are
      either read the same way or explicitly answer `unavailable` with a reason. The checklist on
      ARMEPS documents is a spec follow-up, so record which one applies.
- [ ] After the fix, the same tender produces items, each with verbatim evidence that passes
      `verifyEvidence`. Record the item count and one evidence span here.
- [x] Grep for other readers of `findDetail(...).documents` that expect `storage_key`, and fix or
      list them.
- [x] Checklists that were wrongly stored as unavailable are not silently left that way: list how
      many exist locally, and say whether regenerating them is a manual step or happens on the
      next request.

## Results (2026-10-20)

**Code is done; one check is left, and it is a billing problem, not a code one.** The last open box
needs one model call, and the OpenRouter account behind `ANTHROPIC_BASE_URL` is out of credits
(402: "requested up to 16000 tokens, but can only afford 1168"). Top it up, run the command at the
end, record the item count and one evidence span, and set `Status: done`.

**The regression, confirmed on the local DB.** It had no organization, so a throwaway one was
created (`Ticket 16 repro`, user `ticket16-repro@example.invalid`, org `bida9tbed1qwbc336m0t8y1n`). It
tracks e-auction tender `pm62ubvysdar7vjlbb3e94y3` (tid 47818). That tender has the smallest
invitation text among 300 sampled, 248 KB at
`tender-docs/eauction/47818/9ae8145c….txt`. Before the fix, `handleChecklistExtract` answered
`{ status: 'unavailable', reason: 'no_document' }` and stored that, even though the `.txt` was in
MinIO. Every one of the 40 most recent e-auction invitations has its `.txt`.

**The fix.**
- `TenderRepository.findWithStoredDocuments(tenderId)` returns `{ id, title, documents: [{ id,
  kind, storage_key }] }` for workers. `findDetail` is unchanged, so no storage key reaches an API
  response.
- After the fix, `loadInvitationText` returns the 144,542-character text, and the handler gets as
  far as the model call. A thrown 402 from the gateway is what stops it there.

**ARMEPS → `unavailable` / `unsupported_document`.** ARMEPS stores its archive as
`contract_documents` (53 locally), and nothing writes a `.txt` for it: only the e-auction
`documents.js` does. So a tender that has a stored document but no invitation answers
`unsupported_document`, not `no_document`. Verified on tracked ARMEPS tender
`urj284572svkl4c23gy8igv9`. Reading ARMEPS text is the spec follow-up. A stored invitation whose
`.txt` is missing now answers `no_text` (before, it was `no_document`), because its repair is to
re-run the document stage. Every `failureReason` is now listed in `docs/API_REFERENCE.md` under
GET checklist.

**Other `findDetail(...).documents` readers.** There is only one,
`TenderDocumentService.present`, and it uses no `storage_key`. File downloads go through
`findDocument`, which selects it. Nothing else was broken.

**Wrongly-unavailable checklists: 0 locally.** The local DB had no checklists before the repro.
Neon was not checked. Regenerating is **the next generate request**, with no `force` needed: the
worker skips only `ready` checklists, and the API refuses only `pending` ones. A GET does not
re-run anything.

**Found in review, and fixed here because it blocked the outcome: the API could not enqueue a
checklist at all.**
- `ChecklistService.generate` used job id `checklist:<id>`, which BullMQ 6.0.5 refuses ("Custom Id
  cannot contain :"). The refusal came *after* the row was marked `pending`, so every real
  generate left the checklist pending, and every later request answered 409. The repro above
  called the handler directly, so it did not see this.
- The id is now `checklist-<id>`.
- A finished job also keeps its id (completed for 24 h, failed forever, since `removeOnFail: false`),
  and re-adding under a taken id is a silent no-op. So `generate` now removes a completed or failed
  job with that id before adding.
- Verified through `ChecklistService.generate` on the real queue: it enqueues
  `checklist-vesioaqtyxtdq8uxkdwpekzy`, and a second generate answers `CONFLICT`. The four BullMQ
  behaviours were verified on an empty scratch queue: a colon id throws, a plain re-add over a
  completed id does not run, the same id re-queues over a completed job, and again over a failed
  one.
- A job that fails for good still leaves the row `pending`. That is ticket 20.

**To finish:** add OpenRouter credits, then run this from the repo root. `.env`'s
`AI_MODEL=claude/claude-opus-5` is not a valid OpenRouter id ("is not a valid model ID"), so the
command overrides it; fix `.env` to `anthropic/claude-opus-5` as well.

```bash
AI_MODEL=anthropic/claude-opus-5 node --input-type=module -e "const { handleChecklistExtract } = await import('./src/workers/aiExtractor.js'); console.log(await handleChecklistExtract({ data: { trackedTenderId: 'xc3jbzh2c9idopep7fm883j5', organizationId: 'bida9tbed1qwbc336m0t8y1n' } })); process.exit(0)"
```

Then record `kept` from the result and one `evidence` from `checklist_items` for checklist
`avfj7wgoditx8c37o8zo3yzs`. Delete the repro organization and user once done.
