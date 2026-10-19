# 05 — ARMEPS tenders appear in Discovery

**What to build:** A supplier sees ARMEPS open tenders and quotations in the tender list, labelled
`armeps`, with deadline, CPV, evaluation method, purchase kind and the documents (invitation in HY,
EN and RU, bill of quantities). Saved-search alerts and the relevance ranking pick them up exactly
as they do e-auctions. A gnumner notice and its armeps.am page are one tender. Spec: *Sources and
parsers → armeps.am*. ADR 0004 matching rule 2.

**Blocked by:** 03, 04, 14

**Status:** done

- [x] An `armeps` adapter (the real armeps.am) with a client and a pure detail parser for the CfT
      page, reached by `resourceId` only. It has no listing.
- [x] The parser yields buyer, titles in HY/EN/RU, procedure code, procedure type, evaluation
      method, purchase kind, CPV, deadlines and the document list. The `c4t_*.xml` tender
      structure yields lots.
- [x] Each detail becomes an observation through the resolution module. The tender carries an
      `armeps` link (role `detail`) and a `gnumner` link (role `discovery`), and is never two
      records. Re-fetching changes nothing.
- [x] `submission_channel = 'armeps'`. `procedure_type` comes from the page (open, quotation, and
      so on), never `e_auction`.
- [x] Documents are stored and listed through `tender_documents`, from our stored copies, never
      fetched on a click.
- [x] An amended CfT page raises a new version and re-notifies through the existing amendment
      path.
- [x] **ARMEPS tenders are refreshed.** gnumner's notice may never change while armeps.am moves a
      deadline, so nothing would re-fetch the page. Unsettled ARMEPS tenders (not awarded or
      cancelled, within a refresh window) are re-fetched on a schedule, the counterpart of
      `tender.refresh`, with its own config knobs and a scheduler id derived from the source key.
- [x] **The detail job id stays `armeps-detail-{resourceId}-{fingerprint}`**, as ticket 04 built
      it and as e-auction does. A changed gnumner notice must trigger a new fetch, and a
      `resourceId`-only id would be swallowed by BullMQ while the earlier job is still kept as
      completed. Duplicate fetches are cheap, because the detail handler dedupes the payload by
      hash. Refresh jobs use their own id scheme and must not collide with discovery ids.
- [x] **No hardcoded hosts in the gnumner listing parser.** It stays pure but takes its base URL
      and the three hosts (gnumner, armeps.am, eauction) as a parameter built from the sources
      config, as eauction's `parseDetail(html, { baseUrl })` already does. Relative links resolve
      against the configured gnumner base, and `SOURCE_GNUMNER_BASE` then really changes
      classification. armeps.am's own base URL lives in its sources-config entry.
- [x] Raw HTML is kept, and replay from storage works.
- [x] **Before writing anything, confirm `raw/armeps/` and `tender-docs/armeps/` are empty and the
      legacy folder map is gone (ticket 14).** If either still holds e-auction objects, stop: an
      armeps.am object written there would be indistinguishable from them. Then armeps.am writes
      under its own `armeps` folders, and a reindex dry run over a mixed set maps its keys to
      `armeps` and e-auction keys to `eauction`.
- [x] Verified by hand against three live CfT pages (including resourceId 12315509). Record the
      parsed fields next to what the page shows.
- [x] `GET /tenders?submissionChannel=armeps` returns them, and a saved search with a matching CPV
      raises an alert.

## Verification — 2026-10-20

Against the local database `tendra`, the local MinIO bucket and the local Redis
(`localhost:6379`; the `Tendra-redis` container publishes no port and is not the one the app
uses). No full worker was run: `ingest.fetch` holds an e-auction backlog (1,459 document and 207
detail jobs) that was left alone. The ARMEPS jobs were run one by one through the production
`processIngestFetch` (rate limit included) and the normalize queue by a normalize-only worker.

**Ticket 14 first.** Before anything was written: `raw/armeps/` 0 objects, `tender-docs/armeps/`
0, `docs/armeps/` 0; `source_payloads` and `tender_documents` rows naming an `/armeps/` key: 0;
`LEGACY_STORAGE_FOLDERS` absent from `src/`, `docs/` and CLAUDE.md.

**e-auction unchanged by the refactor.** A canonical dump of `tenders`, `tender_sources`,
`tender_lots`, `tender_documents`, `awards`, `public_tender_bids`, `parties` and
`unmatched_results`, then `npm run normalize:replay`: 1,152 unchanged, 0 events, 0 jobs queued,
every table byte-identical. Repeated after the review fixes over 1,206 payloads (e-auction and
ARMEPS): 1,206 unchanged, identical again.

**Ingestion.** The 53 `armeps.detail` discoveries ticket 04 had parked, plus 12315509 by hand (it
is from July and no longer on gnumner's first pages):

| | |
|---|---|
| CfT pages stored, tenders created | 54: 31 `open`, 23 `quotation` (all `submission_channel = 'armeps'`) |
| links | every tender `armeps`/`detail`; 53 also `gnumner`/`discovery` (12315509 had no notice) |
| unmatched results | 0 |
| CPV, deadline, evaluation method | 54 of 54 (`lowest_price` throughout) |
| purchase kind | 19 goods, 8 works, 27 services, stored as e-auction's Armenian labels |
| documents | 53 archives stored and listed (242 files); 1 refused: 12537340 is over the 60 MB cap |
| lots (Tender Structure XML) | 92 lots on 18 tenders, 88 with a CPV; the other 36 tenders are one contract (`num-of-lots="0"`) |
| status | 53 `active`, 12315509 `closed` (deadline 2026-07-28; awarded is PPCM's, ticket 10) |

**Re-fetching changes nothing.** The first refresh re-stored 29 of 53 pages: the session id
contains `+`, and the canonicalisation regex stopped at it. Fixed; the next refresh stored 4
(the pages still holding a fragment), all normalized unchanged, and the one after that **53
unchanged, 0 stored, 0 normalize jobs**. Documents: 29 re-downloads, all unchanged (the set
hash is stable although the ZIP's bytes and its generated listing PDF differ per download).

**Amendment.** A copy of 12543933's page with the deadline moved two days, stored and
normalized: `TenderAmended`, version 2, `changedFields: ["deadline_at"]`, job
`match-…-v2` with `event: TenderAmended`, and an `amendment` notification to a throwaway
organization's matching search. The real page normalized back to version 3 with the real
deadline; the fake payload, both match jobs and the organization were removed, so no alert for
a deadline that never moved can reach anyone.

**API and alerts.** `filter[submissionChannel]=armeps` through `tenderQuerySchema` and
`TenderService.search` (the controller's path, without auth): 54 tenders, all `armeps`.
`armeps` + `eauction` with `purchaseKind=works` returns both. A file streamed out of a stored
ARMEPS archive through `TenderService.documentFile` matched its manifest size (255,331 bytes).
The local database has no saved searches, so a throwaway user, organization and search (CPV
44163300, no linked channel) were created, `handleTenderMatched` run on 12542029 (`exact CPV
match`, one `tender-match` notification, delivered to the dev `log` channel), and all three
deleted. 54 genuine `TenderIngested` match jobs wait in `alerts` for a real worker.

**Reindex dry run** (parse every `raw/` key, write nothing): 2,589 `eauction`, 87 `armeps`, 10
`gnumner`, 0 skipped; 0 `source_payloads` rows whose key's folder is not their source.

**gnumner parser.** With hosts and base from the config, page 1 of each listing classifies as
in ticket 04 (open: 7 armeps, 2 paper; quotation: 3 armeps, 6 paper). A relative upload link is
`paper` under the configured base and `other` under another one.

### By hand: three CfT pages, page vs. stored

Times are Yerevan on the page and UTC in the database.

**12315509** — `listContractDocuments.do?resourceId=12315509`

| field | page | stored |
|---|---|---|
| buyer | ՀՀ Արարատի մարզ Մասիսի համայնքապետարան | same |
| title HY / EN / RU | ՀՀ Արարատի մարզի Մասիս համայնքի … ձեռքբերում / Procurement of works for the construction of an educational greenhouse … / Закупка работ по строительству учебной теплицы … | HY in `title`; EN and RU parsed (not stored, see below) |
| CfT Id | ԱՄՄՀ-ԳՀԱՇՁԲ-26/30 | `referenceCode` same |
| procedure | Request for Quotations | `quotation` |
| evaluation | Lowest Price | `lowest_price` |
| procurement type | Works | `works` (Աշխատանք) |
| CPV | 45221142-ընդհանուր շինարարական աշխատանքներ | `45221142` |
| time-limit | 28/07/2026 15:00 | `2026-07-28T11:00Z` |
| clarifications | 21/07/2026 12:32 – 23/07/2026 15:00 | `qnaDeadlineAt` `2026-07-23T11:00Z` |
| published | 21/07/2026 12:46 | `2026-07-21T08:46Z` |
| lots | Contract awarded in Lots: No | none (c4t `num-of-lots="0"`) |
| documents | Invitation (10).doc EN, Приглашение (9).docx RU, Հրավեր 26-30.docx HY, Նախագիծ-նախահաշիվ (1).rar HY, c4t_12315509_1.xml EN | the same five, same languages |

**12542029** — open, two lots

| field | page | stored |
|---|---|---|
| buyer | ՀՀ պաշտպանության նախարարություն | same |
| CfT Id | ՀՀ ՊՆ-ԲՄԱՊՁԲ-27-7/7 | same |
| procedure / evaluation / type | Open / Lowest Price / Supplies | `open` / `lowest_price` / `goods` |
| CPV | 44163300-ռետինափողրակներ | `44163300`, and on both lots |
| time-limit | 20/11/2026 11:00 | `2026-11-20T07:00Z` |
| clarifications end | 15/11/2026 11:00 | `2026-11-15T07:00Z` |
| published | 19/10/2026 11:56 | `2026-10-19T07:56Z` |
| lots | Number Of Lots 2: [1] … Փ-66մմ, [2] … Փ-77մմ | lots 1 and 2, same names |
| documents | 3 invitations (EN and RU share one file name), c4t XML | 4 files; the HY one `hy`, the two sharing a name `null` |
| links | — | `gnumner` (open listing) + `armeps` |

**12543933** — quotation, services

| field | page | stored |
|---|---|---|
| buyer | ՀՀ ներքին գործերի նախարարություն | same |
| CfT Id | ՀՀ ՆԳՆ ԳՀԾՁԲ-Ա-68/2026 | same |
| procedure / evaluation / type | Request for Quotations / Lowest Price / Services | `quotation` / `lowest_price` / `services` |
| CPV | 50841400-զենքի մալելու ծառայություններ | `50841400` |
| time-limit | 27/10/2026 14:00 | `2026-10-27T10:00Z` |
| clarifications end | 22/10/2026 14:00 | `2026-10-22T10:00Z` |
| published | 19/10/2026 17:15 | `2026-10-19T13:15Z` |
| lots | Contract awarded in Lots: No | none |
| documents | 3-Notice.docx EN, 2-Приглашения-на русском.docx RU, 1-Հրավեր-Հայերեն-Ծառայություն.docx HY, c4t XML | same four, same languages |
| links | — | `gnumner` (quotation listing) + `armeps` |

### Decided while building

- **What is stored is the canonical page**, not the response bytes: per-request `jsessionid`,
  clock, pager key, calendar and "Last update" removed (`canonicalPage`). It is hashed and
  stored, so a key's hash stays the sha256 of its bytes and an unchanged tender writes nothing.
- **The documents ZIP's identity is the buyer's files** (path, CRC, size), not its bytes, which
  differ per download. The stored ZIP's key carries that hash, so a future move script must not
  re-check it as the archive's sha256.
- **A refresh re-normalizes an unchanged page** (hourly id), because the page states no status
  and a deadline passing changes no page; without it a tender would stay `active` forever. And
  `deriveStatus` reopens a `closed` that only the deadline said, when the deadline moves ahead —
  a late extension. Documents are queued only for a newly stored page or a changed tender.
- **`tender.refresh` is per source.** For ARMEPS it reads every unsettled tender with a deadline
  ahead or less than `refreshWindowDays` (3) behind, stalest link first, every 3 hours. Ids
  `armeps-refresh-{resourceId}-{hour}`; discovery ids stay `armeps-detail-{resourceId}-{fp}`.
- **The gnumner link's external id is `armeps:{resourceId}`**, the target that identifies a
  notice (ticket 04's ref), and its URL the listing page. ADR 0004 says "the gnumner notice
  URL"; for an ARMEPS notice that URL is the armeps.am page itself.
- **`tenders.evaluation_method`** (nullable, a code derived from the label) added with the
  four-step workflow: script run twice on `tendra`, mirrored into `create_table.js`, deleted in
  the next commit (`git show d494592:migrations/add_evaluation_method.js`). Neon is not
  touched; whoever migrates it runs that script with tickets 01 and 14's.
- The scheduler registers no sweep for a source without a listing and removes a leftover
  `sweep-{source}`; the health check skips freshness for such a source.

### Review (`/code-review`, standards and spec)

Fixed from it: the status never leaving `active` (above); `documents:manifests` listing an
ARMEPS archive with e-auction's builder (it now picks by `kind`); `linkDiscovery` moved from a
worker into `services/discoveryLink.service.js`; unused parsed fields dropped.

Left, on purpose or for a later decision:
- **An addendum alone does not re-notify.** A new document row with no field moved stores a new
  archive beside the old one, but raises no version. Whether a new addendum should be an
  amendment (it often changes requirements) is a product decision; it would need the document
  fingerprint in the amendment hash or a version bump from the document stage.
- **Only the first CPV is stored on the tender.** A multi-CPV tender's other codes reach the
  lots only where a lot name starts with that code's label (88 of 92 lots matched); in
  12543482, `09211150` is on neither the tender nor a lot, so a saved search on it misses it.
- **EN and RU titles are parsed, not stored** — there are no columns for them.
- **Buyers are keyed per source.** 25 of the 31 ARMEPS buyers already exist as e-auction parties
  under the same name, so a buyer profile splits by channel. Merging parties across sources is
  its own decision.
- A gnumner link is lost if the page's first normalize fails and is later only replayed (a
  replay carries no discovery); retrying the failed job keeps it.
- Job payloads are checked only for `resourceId` on dequeue, as loosely as the existing handlers.
- Seen in passing, not part of this ticket: `tenders.findDetail` selects `tender_documents`
  without `storage_key`, while `aiExtractor.js#loadInvitationText` reads
  `invitation.storage_key` from it — so the AI checklist looks like it always gets no text.

