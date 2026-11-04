# 18 — A new addendum is an amendment

**What to build:** When a buyer adds a document to an open tender (an addendum), suppliers who
matched or track that tender are told, even if no field Tendra stores moved. Decided 2026-10-20: an
addendum usually changes requirements, and a supplier preparing a bid against the old documents
loses the bid. Found in ticket 05: today a new addendum stores a new archive but raises no version
and sends nothing.

**Blocked by:** None — can start immediately (ticket 05 is done).

**Status:** done

- [x] For ARMEPS, a change in the buyer's document set (`documents.js#documentSetHash`: path, CRC
      and size of the buyer's files, never the archive bytes, which change on every download) is
      part of what counts as an amendment. It raises a new `version`, sets `amended` while the
      tender is open, and re-notifies through the existing amendment path.
- [x] The change summary names what changed ("new document: <file name>"), and the alert says so.
      It never claims a field changed when none did.
- [x] No notification for an addendum on a tender that is past deadline, awarded or cancelled.
      Its version is still recorded, so history is complete.
- [x] `notifications_dedupe_uq` still prevents a duplicate for one event, while a second addendum
      on the same tender is a new event. Record how the existing amendment path keys this.
- [x] **e-auction: measure before switching it on.** Ticket 14 found 396 stored invitation archives
      that are older content hashes of a re-issued invitation. Compare their file sets (path, CRC,
      size). Count how many re-issues changed the buyer's files and how many changed only bytes.
      Apply the rule to e-auction only on the file-set identity, and record the counts here. If
      e-auction's archive needs its own set-hash builder, add it beside its parser.
- [x] Paper follows the same rule through ticket 07: an amendment notice is itself an addendum.
- [x] A replay from storage raises no notification for an addendum that was already processed.
- [x] Verified by hand on one real ARMEPS addendum: version, change summary and one alert job.
      Record it here.

## Verification — 2026-10-20

Against the local database `tendra`, the local MinIO bucket and the local Redis. No worker was
running. The ARMEPS jobs ran one by one through the production handlers (`handleArmepsDetail`
with `reason: 'refresh'`, `normalizeTender`, `handleArmepsDocuments`, rate limit included), and
each job a changed page queued was removed once it had run.

### e-auction: measured first, then switched on (owner's decision)

| | |
|---|---|
| e-auction `.zip` objects in `tender-docs/eauction/` | 1,483, in 1,483 tender folders. **No tender has two.** |
| archives with no `source_payloads` row (ticket 14's 396) | 396 |
| — belonging to no tender in the database | 332 |
| — belonging to a tender with no `tender_documents` row (45 awarded, 17 cancelled, 2 closed) | 64 |
| re-issues whose buyer files changed | **0**: there is no pair to compare |
| re-issues whose bytes alone changed | **0** |
| 3 open tenders (48078, 48187, 48190) re-downloaded and compared with the copy from 10-18 | 3 of 3 byte-identical, same file set |
| recorded archives already containing `popoxutyan_pastatuxt.*` (the amendment notice) | 84 of 1,087 (7.7%) |

**Ticket 14's reading was wrong.** The 396 are not older content hashes of a re-issued
invitation; each one is the only archive in its tender's folder. The e-auction invitation is a
static file at a fixed URL, so its bytes and its file set agree. Re-issues do happen (84
amendment notices), but Tendra only ever holds the first copy it downloaded. The document job
id is keyed on that URL, so a re-issue is downloaded again only when the detail page changes
more than a day after the last download. The owner chose to switch the rule on for e-auction
anyway, on the file-set comparison, and moved the re-download to **ticket 27**. No separate
set-hash builder was needed: the rule compares the stored file lists
(`tender_documents.manifest`: name, CRC, size), which both sources already write.

The e-auction path was checked through `AddendumService.recordDocuments` on real rows
(48190 active, 47036 awarded). Each fake document row was removed and each version restored
afterwards:
- **Bytes only** (another key, same files): no version, no job.
- **A new file:** v2, `amended`, one job `match-…-v2` with `changedFields: []` and
  `documentChanges.added: ["popoxutyan_pastatuxt.pdf"]`.
- **The same set again** (a retry): still v2, still one job.
- **Awarded tender:** v2 recorded, status kept, no job.
- **First set** (no previous): nothing.

### By hand: one real ARMEPS addendum

The refresh of the 53 open ARMEPS tenders:
- **45** unchanged.
- **6** answered 503: armeps.am was degraded and taking 60 s per page. The run used
  `SCRAPER_HTTP_TIMEOUT_MS=90000`.
- **12538123** re-stored with no document change. armeps.am had left out the page's second
  pager block, so it was not an addendum; normalize reported it unchanged. Its documents job
  hit a 503 and is still queued.
- **12544122** (`ԲԿԳԿ-ԲՄԱՇՁԲ-26/79`, Higher Education and Science Committee) had a real
  addendum:

| | before | after |
|---|---|---|
| CfT page | stored 10-20 00:56 | re-stored 20:34; no tender field moved (normalize: unchanged) |
| document sets (`documents:12544122`) | `72ef0737…`, 4 files | `58506c29…`, 5 files, stored beside the first |
| version / status | 1 / `active` | **2 / `amended`** (deadline 2026-11-20) |
| change | — | `added: ["Նախագծանախահաշվային փաստաթղթեր.zip"]`, nothing replaced or removed |
| alert jobs | `match-…-v1` (ticket 05's ingest) | plus exactly one: **`match-z2l852z15rbdyj0uxzqadf0v-v2`**, `event: TenderAmended`, `changedFields: []` |

The refresh ran on the code from before the review fixes below; their behaviour is the same
for this case. Then, on the current code:
- **The hourly re-normalize of the stored page:** unchanged, still v2 `amended`. Before
  `deriveStatus` kept `amended`, this run would have reverted it to `active` and alerted
  "status".
- **The matcher**, with a throwaway user, organization and saved search on CPV 45311132:
  v2 notified 1 organization, subject `v2`. The same job again notified 0. A second
  amendment (v3) notified 1 more. The rendered alert's change line was
  `Changed: new document: Նախագծանախահաշվային փաստաթղթեր.zip` in both Telegram and email.
  All three throwaway rows were then deleted.

### How the amendment path is keyed (asked for above)

- **The job:** `match.tender` under `match-{tenderId}-v{version}` (`queues/names.js#matchJobId`).
  The normalizer and the document stage both build it there. They advance one `version`
  counter, each under the tender's row lock, so one amendment is one id.
- **The notification:** before this ticket it was keyed `(org, 'amendment', tender, NULL)`.
  So **the first amendment of a tender was the only one any organization was ever told
  about**: a second deadline move or addendum hit the first one's row and was silently
  dropped. The subject is now `v{version}`. A retry carries the same version and stays
  deduped; a second addendum is a new version and a new alert. This applies to field
  amendments too.

### Decided while building

- **The rule lives in `services/addendum.service.js`**, source-neutral. The document stage
  calls `recordDocuments` in place of `tenders.applyInvitationFacts`. The version moves in the
  transaction that writes the new document row, and only when that row is new.
- **Open** means a status the matcher alerts on (planned, active, amended) with the deadline
  ahead. Only `active` becomes `amended`; a planned tender stays planned.
- **`amended` is kept over `active`** in `deriveStatus`, and again under `saveNormalized`'s row
  lock. Otherwise a normalize that read the status before an addendum committed would revert
  it and alert a status change. The race was found in review.
- **A tender's first set is not an addendum.** A set whose previous file list is unknown
  (unlisted) raises nothing and logs a warning.
- **`money(null)` rendered "0 AMD"** in every alert for a tender with no estimated value: all
  ARMEPS tenders and 406 e-auctions. It now leaves the line out.

### Review (`/code-review`, standards and spec)

Fixed from it:
- the status race (above);
- `planned` was wrongly excluded from alerts;
- the previous-set lookup moved from both workers into the service;
- one `matchJobId` instead of two spellings;
- `recordAddendum` no longer rewrites `is_latest`;
- the `notification.repo.js` comment.

Left, known and accepted:
- **Trackers are not reached.** "Suppliers who … track that tender" are told only if a saved
  search matches, as before this ticket. That gap is **ticket 28**.
- **Every amendment now alerts.** Not just the first per tender (see above); expect more alert
  volume.
- **One buyer edit can give two alerts.** An addendum that also moves the deadline yields
  v(n+1) "deadline_at" from the normalizer and v(n+2) naming the file from the document stage.
  Each is true.
- **Two narrow windows, documented in the service:**
  - a crash after the commit and before the payload is recorded, with a field amendment landing
    in between, loses the document alert;
  - two document jobs for one tender running at once compare with the same previous set.
- **A set that changes back** (A → B → A) is not seen the third time: `existsWithHash` matches
  any stored hash for the ref. This predates the ticket.
- **At deploy:** a matcher job queued before it carries no `version` and falls back to the
  tender's current one. An amendment already alerted under a NULL subject can then alert once
  more.
- **Paper** gets the rule through the document stage when ticket 07 builds it; nothing here is
  paper-specific.
