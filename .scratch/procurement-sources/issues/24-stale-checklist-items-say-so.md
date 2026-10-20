# 24 — Checklist items from an older document say so

**What to build:** When a tender's invitation changes and the new extraction fails, a supplier
looking at the checklist is told that the items shown come from the **previous** version of the
document, not left to infer it from `generatedAt`. Items describing requirements a buyer has since
changed, shown as if current, are the same kind of danger as an empty list: a supplier prepares
against requirements that no longer hold. Found in ticket 23 ("Known, not changed"). It matters more
once ticket 18 makes document changes amendments.

**Blocked by:** 18

**Status:** done

Today `document_hash` records which text the stored AI items came from, and is written only with
those items (ticket 21). A failed extraction of a changed document keeps both, which is right
(ticket 23), but nothing compares that hash with the document the tender holds **now**.

- [x] The checklist response says whether its AI items come from the tender's current invitation
      text, for example `itemsCurrent: true | false` (or `null` when unknowable). It is derived by
      comparing the stored `document_hash` with the current document's hash, and never stored as
      a flag that could go stale itself.
- [x] Getting the current document's hash does not mean reading a 150 KB text on every GET. Record
      where it comes from: a hash stored once by the document stage beside the text, or something
      better.
- [x] `failed` with stale items, and `ready` with stale items (the document changed after a good
      extraction and nobody has regenerated yet), both report `itemsCurrent: false`.
- [x] Manual items are not affected: they are a person's assertion, not an extraction of a
      document version.
- [x] `docs/API_REFERENCE.md` documents the field and tells a client to show it.
- [x] Verified with a stubbed extract: a good extraction → `true`; the document changes → `false`
      before any regenerate; the regenerate fails → still `false`; a successful regenerate →
      `true`.

## Results (2026-10-20)

**How it was verified.**
- The model was stubbed at the adapter's `ai.completeStructuredStreaming`, as in ticket 23, so
  `extract`'s validation and `verifyEvidence` ran for real. The stub counted its calls. No AI
  request was made.
- Every run went through `handleChecklistExtract`, and every reading through the real
  `ChecklistService.forTracked` (the GET).
- The subject was ticket 16's repro checklist `avfj7wgoditx8c37o8zo3yzs`, over its real invitation,
  with its one manual item.
- "The document changes" was a second invitation for the same tender. Its text was the original
  plus one appended Armenian clause, written to storage. Its row went in through
  `tenders.applyInvitationFacts`, the call the document stage makes.
- Afterwards the extra row, its text object and the AI items were removed, and the checklist row
  was restored. It reads `failed` / `no_items`, `itemsCurrent: null`, 1 item, as it did before.

| Step | Model calls (total) | `status` | `itemsCurrent` | AI items | Manual item kept |
|---|---|---|---|---|---|
| As found (`failed`, no AI items) | 0 | `failed` / `no_items` | `null` | 0 | yes |
| Good extraction (`force`) | 1 | `ready` | **`true`** | 2 | yes |
| Document changed, no regenerate | 1 | `ready` | **`false`** | 2 | yes |
| Regenerate, the stub answers nothing | 2 | `failed` / `no_items` | **`false`** | 2 (old) | yes |
| Successful regenerate | 3 | `ready` | **`true`** | 2 | yes |
| Plain regenerate, unchanged | 3 | `ready` | `true` | 2 | yes |
| Re-issued again, no extractable text | 3 | `ready` | **`false`** | 2 | yes |
| Regenerate | 3 | `unavailable` / `no_text` | **`false`** | 2 (old) | yes |

In the successful regenerate, one stub item quoted only the appended clause and was kept, so the
worker read the new invitation and not the old one. The last two rows were added after review: a
new invitation with no text has no hash, and reporting `null` there would hide items that are
known to be stale.

**Where the current hash comes from:** `tender_documents.text_hash`. The document stage writes it
in the transaction that records the row, using `ChecklistExtractionService.documentHash` over the
text it has just stored, the same function that produces `checklists.document_hash`. A GET reads
one indexed row and no text. The document stage hashes the parsed text in memory; everything else
hashes the text read back from storage. A check on 40 random stored archives (re-parsed and hashed)
matched `text_hash` 40 of 40.

**"Current" had to be defined first.** After ticket 18 a tender holds one invitation row for each
document set. `findWithStoredDocuments` ordered those rows by `id`, which is a random CUID2. So the
checklist could read the *old* invitation after an addendum, and "the current document" had no
meaning. `tender_documents.stored_at` now orders them, newest first. The rule is
`NEWEST_DOCUMENT_FIRST` in `tender.repo.js`. Both the worker's `loadInvitationText` and the GET's
`findCurrentInvitation` use it, so the text that is extracted and the hash it is compared with
always come from the same row. Locally no tender held two invitations yet, so this was latent.

**`null` means:** no AI items, or no invitation to compare with. A current invitation with no
`text_hash` is `false`, not `null`. AI items were read from some text, and it was not this one.
Every invitation with readable text carries a hash: the document stage writes it, and the
migration filled the older rows. The value is derived on every read and never stored.

**Schema.** The additive script is `migrations/add_tender_document_text_hash.js`. It adds
`stored_at` and fills it from each archive's `source_payloads.fetched_at`. It adds `text_hash` and
fills it from stored text, blanks only. The changes are mirrored into `create_table.js`.
- **Local `tendra`:** applied. 1,093 invitations were hashed, 0 had no text, and all 1,147 rows got
  a distinct `stored_at`. A second run changed nothing.
- **Neon:** not applied. Run the script **before** the code deploys. The new code writes
  `text_hash` and sorts on `stored_at`, so against the old schema every document job and every
  checklist read fails. Run it once more after the deploy, to fill invitations the old code stored
  in between, then delete the script.

The text key next to an archive now comes from one storage-port helper,
`tenderDocTextKeyOf`. The worker and the migration both use it.

**Known, not changed.**
- `findDetail`, the tender page's document list, still orders by `id`. It lists every set and picks
  none, so nothing reads the wrong one, but its order is arbitrary.
- An e-auction invitation that returns to bytes stored before (A → B → A) is skipped by the
  payload dedupe. The tender then still "holds" B. This predates the ticket, and the addendum
  check has the same blind spot.
