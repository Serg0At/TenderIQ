# 30 — Bring Neon and the deployed environment up to date

**What to build:** The deployed database, bucket, Redis and environment variables reach the shape
the code now expects, in the order that keeps each step valid. Every ticket in this feature ran
its migration on local `tendra` only and wrote "Neon is not touched". This is the one list of
everything those tickets deferred, so a deploy cannot miss a step or run them out of order.

**Blocked by:** None. Do it immediately before deploying the code from these tickets, not earlier:
a migrated Neon under old code breaks the old code.

**Status:** ready-for-human

It needs the owner: these steps act on the shared database and bucket.

**Before anything:** stop every process that writes to Neon (the API, workers, scheduler). Back up
Neon (a branch or a dump). Point `PSQL_*`, `REDIS_*`, `S3_*` and `STORAGE_DRIVER` at the deployed
environment, and **check all four before each step**. Ticket 14 explains what a database and
bucket mismatch deletes.

Run in this order. Recover each script with `git show <commit>:<path>`, run it, then run it a
second time to confirm it is a no-op:

- [ ] 1. `5f0bd43:migrations/rename_source_eauction.js`: `armeps` → `eauction` in data and Redis
      (ticket 01).
- [ ] 2. `2372170:migrations/move_eauction_objects.js`: e-auction objects out of the `armeps`
      folders, against **the deployed bucket** (ticket 14). Do not run `npm run reindex` against
      that bucket before this step.
- [ ] 3. `8c63323:migrations/add_tender_sources.js`: submission channel and source links
      (ticket 02).
- [ ] 4. `eb0a34b:migrations/add_unmatched_results.js` (ticket 03).
- [ ] 5. `d494592:migrations/add_evaluation_method.js` (ticket 05).
- [ ] 6. `68d5740:migrations/add_tender_cpv_codes.js`, then `npm run cpv:backfill` (dry run), then
      `npm run cpv:backfill -- --apply` (ticket 17). The backfill sends no alert.
- [ ] 7. `migrations/add_tender_document_text_hash.js` (ticket 24). It is **still on disk on
      purpose**: run it before the deploy, run it **again after** the deploy to fill invitations
      stored in between, and only then delete it (step 4 of CLAUDE.md's schema workflow).
- [ ] 8. `b5cd180:migrations/add_submission_address.js` (ticket 06).
- [ ] 9. `01563d9:migrations/add_tender_source_points_to.js`: `tender_sources.points_to`, filled for
      existing gnumner notices (ticket 07). Run it before the deploy and **again after**, like step 7:
      the old code writes notice links with the column blank, and the new code reads a paper
      invitation's notices only through it — a replay of a file whose notice is blank finds none
      and fails.

- [ ] 10. `migrations/add_listing_notices.js`: the `listing_notices` table and
      `unmatched_results.{procedure_type,was_public}` (ticket 31). **Still on disk**: delete it
      after this step has run on Neon (step 4 of CLAUDE.md's schema workflow). Then
      `npm run notices:backfill`, which fills the table from gnumner listing pages already in
      storage. Neon has none today, so it reports 0, but run it anyway: a page stored by a
      sweep under the old code is otherwise a notice the publicity check never sees.
- [ ] 11. `migrations/add_tender_source_failed_lots.js`: `tender_sources.failed_lots`, the lots
      a gnumner failed-procedure notice named (ticket 09). It has nothing to fill. **Still on
      disk**: delete it after this step has run on Neon (step 4 of CLAUDE.md's schema workflow).
      Run it before the deploy: the new code reads and writes the column on every candidate
      lookup, so ingestion fails without it.
- [ ] 12. `migrations/add_benchmark_discount_excluded.js`: `price_benchmarks.discount_excluded`,
      the awards a stored benchmark's discount left out because their contract is not the
      winning offer (ticket 10 follow-up). Nothing to fill: NULL reads "computed before the count
      was kept", and the nightly recompute writes it. **Still on disk**: delete it after this
      step has run on Neon (step 4 of CLAUDE.md's schema workflow). Run it before the deploy:
      the benchmark upsert writes the column, so a recompute fails without it.
- [ ] 13. `migrations/add_parties_tax_id_index.js`: `parties_tax_id_idx`, the lookup behind
      ՀՎՀՀ-first party resolution (ticket 11). Deliberately not unique. Nothing to fill.
      **Still on disk**: delete it after this step has run on Neon (step 4 of CLAUDE.md's schema
      workflow). Before or after the deploy — the code works without it, only slower.
- [ ] 14. `migrations/add_party_aliases.js`: `party_aliases`, the per-source id of a buyer
      merged into another by ՀՎՀՀ (ticket 19). **Run it before the deploy**: party resolution
      reads it on every new party, so ingestion fails without it. **Still on disk**: delete it
      after this step has run on Neon (step 4 of CLAUDE.md's schema workflow). Then, after the
      deploy, `npm run buyers:merge` (dry run: read the merged pairs and the refused groups),
      then `npm run buyers:merge -- --apply`. It reads only stored documents and raises no
      alert. Locally it merged 17 pairs and refused 2 groups (ticket 19). A refused group is
      merged only on a person's word: `-- --apply --confirm <ՀՎՀՀ>`.
- [ ] 15. `migrations/add_supplier_identities.js`: `supplier_identities`, the set of parties an
      organization bids as (ticket 32). It copies every `organizations.supplier_party_id` claim
      into the table, then **drops that column** and `organizations_supplier_party_uq`. **Run it
      with the deploy, not before**: the old code reads the column, and the new code reads only
      the table. Before running it, record `select count(*) from organizations where
      supplier_party_id is not null`; it reports `claimsCopied`, and the two must agree. A
      second run copies nothing. **Still on disk**: delete it after this step has run on Neon
      (step 4 of CLAUDE.md's schema workflow). After the deploy, `PUT
      /organization/supplier-identity` is gone: a client claims with `POST` and unclaims with
      `DELETE …/:partyId`.

Environment:

- [ ] Rename any `SOURCE_ARMEPS_*` variable to `SOURCE_EAUCTION_{BASE,CRON,REFRESH_CRON,DETAIL_BASE}`
      (ticket 01). An old name silently falls back to the defaults.
- [ ] `SOURCE_EAUCTION_BASE` is the **origin** (`https://eauction.armeps.am`), not the listing URL.
      Otherwise the pager never advances, and ticket 15's guard throws on page 2. Fix local `.env`
      too, if it is not already fixed.
- [ ] `AI_MODEL=anthropic/claude-opus-5` if the gateway is OpenRouter (ticket 16).
- [ ] The e-auction `rateLimit` value is decided: the 32/min edit in `sources.config.js` is
      committed or reverted.

After the deploy:

- [ ] `npm run scheduler`, so the new repeatable jobs (gnumner sweeps, ARMEPS refresh,
      `refresh-gnumner` paper close-out, `refresh-ppcm` ARMEPS results — ticket 10, no
      migration; `missed-ppcm` missed-tender sweep — ticket 12, no migration;
      `sweep-gnumner-eauction`, gnumner's e-auction listing hourly as a coverage check — ticket 34,
      no migration) are registered.
      `missed-ppcm`'s first run asks bid-report about every competitive procedure of the last
      90 days that Tendra lacks, and fetches the armeps.am page of each one it names: on a
      database that has never run it, a few hundred ARMEPS tenders appear, with their document
      archives queued, at the results priority (ticket 12, *For the owner*).
      `sweep-gnumner-eauction`'s first run is a cold start: 5 pages, about two days of
      e-auction notices into `listing_notices`, with its floor beside the watermark. It queues
      no job and creates no tender. Then run `npm run sources:verify` and read its e-auction
      notices block: on a database whose e-auction sweep is current, every notice should be
      held.
- [ ] Every gnumner invitation listing has a floor beside its watermark
      (`sweep:published:gnumner:{open,quotation}:floor`, ticket 31). Its first sweep is a cold
      start and writes it. A watermark with no floor (a sweep under older code) leaves the
      covered window empty: every competitive contract notice stays "unknown", which is safe
      but not useful. Delete that listing's watermark to force a cold start.
- [ ] `npm run notices:replay -- --kind=contract` (ticket 32). It re-reads every stored gnumner
      contract notice from storage through its production `retry` handler. A winner whose notice
      states its ՀՎՀՀ moves from its name-keyed party to `gnumner:bo:{ՀՎՀՀ}`, or to the
      e-auction or PPCM party already holding it: that is ticket 32's merge. Its other bids in
      the same notice move with it. Notices stored under the old code otherwise keep their
      winners keyed by name forever, because an unchanged notice is never read again.
      - **Before:** `select count(*) from supplier_identities s join parties p on p.id =
        s.party_id where p.source_id like 'gnumner:bo:name:%'`. A claim on a name-keyed paper
        party keeps only that party's records. Its re-keyed wins move to the ՀՎՀՀ party, so
        the organization must claim that party too. Locally there were 0 such claims.
      - **After:** record the merge count, ticket 32's open item:
        `select count(distinct p.id) from parties p where p.source_id not like 'gnumner:%' and
        exists (select 1 from public_tender_bids b where b.supplier_id = p.id and b.source =
        'gnumner')`.
      - It raises no alert, and a second run changes nothing. Locally it replayed 31 contract
        and 35 failure notices with byte-identical tenders and unchanged queue counts.
- [ ] `npm run notices:replay -- --unmatched=unsupported_format` (ticket 33). It reads every
      gnumner file left `unsupported_format` again from storage, now that `.rar` and `.7z` are
      read. It runs invitations first, then contract and failure notices, through their
      production handlers. A file that now reads becomes a tender, or a link on one, or moves
      to its real reason (`no_candidate`). One that still does not read stays open, unchanged.
      Run it after the deploy, since the old code reads none of these.
      - **Expect little on Neon.** It held no gnumner payloads when this list was written
        (step 10). The new code reads these formats when it first fetches a file, so only a
        file stored under older code can be waiting.
      - An invitation stored under older code has no `upload:` row naming its notice. The
        replay reports it `skipped no_notice_recorded` and leaves it open. Locally the
        notices were recovered from the worker log (ticket 33, *Replay*).
      - Record the `unsupported_format` block of `npm run sources:verify` before and after.
        A second run changes nothing.
- [ ] One repeat sweep per source writes 0 rows and enqueues 0 jobs. A `normalize:replay` changes
      nothing.
- [ ] Neon checks the tickets left for deploy time:
  - checklists stored `unavailable` / `no_document` since `6f22fab` (tickets 16 and 22);
  - empty `ready` checklists (ticket 23's SQL);
  - rows stuck `pending` (ticket 20).

  Record the counts. They all re-run on their next generate.
- [ ] Delete `migrations/add_tender_document_text_hash.js` once step 7's second run is done, and
      commit.
- [ ] Add any migration from tickets finished after this list was written (08–13, 19). Check
      `git log --diff-filter=A -- 'migrations/add_*'` against this list.
