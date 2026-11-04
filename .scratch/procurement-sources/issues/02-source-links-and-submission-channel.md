# 02 — Source links and submission channel on every tender

**What to build:** Every tender knows its **submission channel** and every **source** it came from.
A supplier sees both in the API and can filter the list by submission channel. Today every tender is
`eauction` with one link, but the shape is ready for the other channels. Spec: *Schema*, *API*.
ADR 0004.

**Blocked by:** 01

**Status:** done

- [x] `tenders.submission_channel` is NOT NULL and constrained to `eauction | armeps | paper` at
      the DB level. Existing rows are backfilled to `eauction`.
- [x] `tender_sources` exists: tender (cascade), source, external id, URL, role
      (`discovery | detail | results`), observed status, first and last seen, with
      `UNIQUE (source, external_id)`.
- [x] Every existing tender has exactly one `eauction` link (external id = tid). e-auction
      ingestion writes and refreshes that link on every detail fetch.
- [x] A concurrent insert that loses the unique race is treated as success, as it is for
      `source_payloads`.
- [x] Tender list and detail responses carry `submissionChannel`. Detail also carries the source
      links (source, URL, role).
- [x] `GET /tenders` and `GET /tenders/relevant` accept a `submissionChannel` filter (one or more
      values), validated by Joi. An unknown value is `VALIDATION_FAILED`.
- [x] `docs/API_REFERENCE.md` documents the field and the filter.
- [x] The schema change follows the four-step workflow, and `create_table.js` and `drop_table.js`
      both carry it.

## Verification — 2026-10-19

Run against the local database `tendra` (the only active one; Neon holds a stale 2026-09-14
snapshot and was **not** migrated) and the local Redis, with the workers stopped.

**Migration script** (`migrations/add_tender_sources.js`, committed with the feature and deleted
in the next commit; recover it with `git log --diff-filter=D -- migrations/add_tender_sources.js`):

| | first run | second run |
|---|---|---|
| `tenders.submission_channel` backfilled to `eauction` | 1152 | 0 |
| `tender_sources` links created | 1152 | 0 |

- Every tender has exactly one `eauction` link (0 tenders with a count other than 1). External id
  is the tid, URL is `detailUrl(tid)`, role `detail`, `observed_status` equals the tender's
  `source_status` on all 1152. First and last seen come from the tender's stored detail payloads
  (`min`/`max(fetched_at)`); none fell back to the run time.
- An insert with `submission_channel = 'fax'` is refused by `tenders_submission_channel_chk`.
- A fresh database built by `create_table.js` matches the migrated one on columns, defaults,
  constraints and indexes of both tables (diffed via `information_schema` / `pg_constraint` /
  `pg_indexes`). The first diff showed the FK name and `now()` vs `CURRENT_TIMESTAMP`; the
  script and the local DB were aligned to what Knex generates. `drop_table.js` drops
  `tender_sources` before `tenders`; `migrate:up` then `migrate:down` both succeed.

**Replay.** Every latest detail payload (1152) was run through `normalizeTender` directly, after
the review fixes too: **1152 unchanged, 0 events, 0 failures**. A fingerprint of `tenders`,
`parties`, `awards`, `public_tender_bids` and `tender_lots` (row count + md5 of every row) is
identical before and after, and the alerts, maintenance and fetch queues hold the same job counts.
No link's `first_seen_at` moved, no `last_seen_at` went backwards, and none was stamped with the
replay time: a link's seen time is the payload's `fetched_at`, so a replay from storage does not
claim the source answered today.

**Links.**

- Five concurrent first-inserts of one `(source, external_id)`, each in its own transaction: all
  five fulfilled, 1 row.
- An observation older than the stored one changes nothing (status, URL, last seen); a newer one
  updates all three.
- `touch` (a 304, or a page whose hash is already stored, where no normalize job runs) advances
  `last_seen_at`, ignores an older time, and is a no-op for a link not yet written.
- A new tender through `saveNormalized` gets its channel and link in the same transaction;
  deleting it cascades the link. A mapped tender without `submissionChannel` fails Joi.

**API** (service and Joi schema, local DB).

- List rows and detail carry `submissionChannel: "eauction"`; detail carries
  `sources: [{ source, url, role }]` (external id stays internal).
- `filter[submissionChannel]=eauction` → 100 of 100 rows `eauction`; `[paper, armeps]` → 0;
  `[eauction, paper]` → 100. `findRankable` (the relevant list) honours it too: `paper` 0,
  `eauction` 206 biddable.
- `fax`, `[eauction, fax]` and the comma form `eauction,paper` are rejected by the schema
  (→ `VALIDATION_FAILED`); repeat the parameter for several, as for `purchaseKind`.

**Review** (`/code-review`, standards and spec): no hard violations, all checkboxes met. Fixed
from it: an older observation could overwrite a newer `observed_status`; `submission_channel` was
not in the amendment fingerprint, so a channel change would have been dropped silently. Also
corrected in CLAUDE.md: `tenders.procedure_type` and `tenders.status` have **no** DB CHECK (it
claimed they did); only the Joi schema pins them. Left as they are: backfilled link ids are md5
substrings rather than CUID2 (never exposed, same as `rebuildAwardsFromBids`), and
`tenders_submission_channel_idx` is unused until a second channel has rows.
