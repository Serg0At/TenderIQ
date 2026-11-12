Status: ready-for-agent

# Inferred CPV codes — a code for every biddable lot whose source states none

Board task: `Tender classification / tagging — assign CPV and category from free text. A
cheap-model bulk pass, and a second route past the 8.8% CPV coverage ceiling` (🔼 #tenderiq/ai).
Decided in a grilling session on 2026-11-13. The terms Stated CPV code, Inferred CPV code and CPV
classifier are in CONTEXT.md; Match, Saved search, Relevance, Field, Biddable tender and Purchase
kind were already there.

## Problem Statement

The board task rests on a figure that is no longer true. Measured on the local `tendra` database
on 2026-11-13, every biddable ARMEPS tender (229 of 229) and every biddable e-auction (288 of 288)
carries a stated CPV code. The gap is **paper**: 97 of 101 biddable paper tenders, and 739 of their
lots, have no code at all. The paper invitation template has a CPV column, and buyers almost
never fill it in. About 15 paper tenders are published a day.

A tender with no code is invisible to everything that asks for one. A saved search on a CPV
code, the field filter, the CPV filter and relevance's CPV signal all pass it by, and only a
saved search that happens to share a keyword with its title finds it. For a supplier, that is a
tender they were never told about, and missed tenders are the #1 churn cause.

Closed tenders have a gap too, but it is a different problem with a different fix. 385 closed
e-auctions, almost all published in July 2026, lack a code because their invitation archive
was never downloaded. Their codes are a stated fact sitting in the source, and fetching the
archive recovers them. No guess is needed.

## Solution

Every lot of a biddable tender whose source states no code gets an **inferred CPV code**,
chosen from Armenia's official **CPV classifier**. It is read from the lot's own wording and is
always shown as a guess. An inferred code makes a tender match saved searches, show up under the
CPV and field filters, and rank in relevance, exactly as a stated code would. It never enters a
price benchmark, a buyer or supplier profile, competitor prices or any other intelligence figure,
and it gives way the moment the source states a code.

The code is chosen, not written. For each lot, Tendra gathers candidate codes: those Armenian
buyers have actually put on similarly named lots, and those whose classifier name resembles the
lot. A cheap model then picks one of the candidates or answers "none". A code outside the
classifier is refused in code. When the model is unsure, no code is written, which is better
than a code that sends a wrong alert.

Inference does not switch on alerts until a backtest has shown it to be right. The test hides
labelled lots and checks the division in at least 90% of them, separately for goods, works and
services.

The closed e-auction gap is closed by running the existing document backfill, not by this
feature.

## User Stories

1. As a supplier with a saved search on a CPV code, I want a paper tender for that kind of item
   to match it even though the buyer gave no code, so that I am told about tenders I can bid on.
2. As a supplier, I want a paper tender for an item in my field to appear under my field filter,
   so that browsing my field shows every channel, not only e-auction and ARMEPS.
3. As a supplier, I want the CPV filter to find paper tenders by inferred code, so that a search
   by code returns the same tenders a saved search on that code alerts on.
4. As a supplier, I want relevance to use inferred codes, so that paper tenders in my line of
   work are ranked rather than buried.
5. As a supplier, I want every inferred code marked as inferred in the API, so that I can tell
   Tendra's guess from the buyer's statement.
6. As a supplier, I want an alert or digest line that matched on an inferred code to say
   "(inferred CPV)", so that I know why a tender reached me and how far to trust it.
7. As a supplier, I want a lot with 30 different items to be coded per lot, so that the "office
   chairs" lot reaches a furniture seller even if most lots are stationery.
8. As a supplier, I want a vague lot ("construction materials") given a broader code rather than
   a falsely precise one, so that it matches the right saved searches and no wrong ones.
9. As a supplier, I want a lot Tendra cannot classify left uncoded rather than guessed, so that
   I am not sent wrong alerts.
10. As a supplier, I want the alert from an inferred code to arrive soon after the tender is
    ingested, and never to delay alerts that match on keywords, so that inference only ever adds
    matches.
11. As a supplier, I want no alert repeated when an inferred code makes a tender match a search
    it already matched, so that the code adds matches without adding noise.
12. As a supplier, I want an inferred code never to cause an "amended" alert, so that a change
    in Tendra's guess is not presented as a change by the buyer.
13. As a supplier, I want the buyer's own code to replace an inferred one as soon as the source
    states it, so that a fact always beats a guess.
14. As a supplier, I want a lot whose name changes in an amendment to be coded again from its
    new name, so that its code follows what the buyer now asks for.
15. As a supplier reading intelligence, I want benchmarks, profiles and competitor prices built
    only on stated codes, so that a price figure is never computed over guessed comparables.
16. As a supplier, I want an Armenian name beside every code in the API — stated or inferred — so
    that `44163140` reads as «ջրի և գոլորշու խողովակներ».
17. As a supplier, I want inferred codes on lots of any channel whose source is silent, so that
    the rule is "the source states nothing", not "paper".
18. As the product owner, I want codes inferred only for tenders that are biddable when ingested,
    so that the model is not paid to code history that no alert or figure would use.
19. As the product owner, I want every code to come from the official CPV classifier, so that
    Tendra never presents a code that does not exist.
20. As the product owner, I want the classifier kept in the database and refreshed by a script I
    run, so that I see what changed before it applies.
21. As the product owner, I want the classifier's Armenian names decoded correctly from the
    ministry's legacy encoding, so that names are readable everywhere they appear.
22. As the product owner, I want each inferred code to record how it was chosen (method, model,
    classifier date), so that a later re-run is a deliberate choice and the history is
    explainable.
23. As the product owner, I want a backtest over labelled lots before alerts read inferred codes,
    so that I know the accuracy before customers see it.
24. As the product owner, I want the backtest reported per purchase kind, so that a high score
    on goods does not hide a poor one on services and works, which is what paper buys.
25. As the product owner, I want a hand-labelled set of about 50 paper lots in the backtest if
    ARMEPS gives too few labelled services and works, so that the gate is measured on lots like
    the ones it will code.
26. As the product owner, I want the backtest to compare the model with a no-model baseline (the
    nearest labelled lot's code), so that I know whether the model earns its cost.
27. As the product owner, I want lots that could not be classified counted, so that coverage is
    a number, not an impression.
28. As the product owner, I want inference cost borne by Tendra and never charged to any
    organization's quota, so that a background pass over public data does not spend a tenant's
    allowance.
29. As the product owner, I want lot names treated as data and never as instructions, and the
    output schema-constrained, so that a lot named "ignore previous instructions" is just a lot.
30. As the product owner, I want a model refusal or outage to leave lots uncoded and counted,
    never to fail ingestion or block an alert, so that the AI layer degrades rather than breaks.
31. As the product owner, I want the closed e-auction gap closed by the document backfill, so
    that 385 tenders get their stated codes back without a guess.

## Implementation Decisions

**The two kinds of code never share a column.** Stated codes stay exactly where they are
(`tenders.cpv_code`, `tenders.cpv_codes`, `tender_lots.cpv_code`). Inferred codes get their own
column on the lot. Every intelligence query reads only the stated columns today, so leaving them
untouched keeps intelligence free of guesses by construction. No intelligence query is edited
and none can forget a filter. A lot holds an inferred code only while its stated code is null.

**Schema** (straight into `create_table.js` / `drop_table.js`):

- `cpv_classifier`, the official list: code (8 digits, primary key), Armenian name, unit
  (nullable), and the classifier version (the date of the ministry's file). One row per code.
  A trigram index on the name serves candidate search.
- `tender_lots` gains `inferred_cpv_code` (nullable; referencing `cpv_classifier`), and the
  provenance of how it was chosen: method (`model` | `nearest`), model id (nullable), classifier
  version, and the time it was inferred. A CHECK ensures an inferred code is never set where a
  stated one is.
- `pg_trgm` is enabled for name similarity (beside the `btree_gist` already in use), with a
  trigram index on `tender_lots.name` for candidate search.

**The CPV classifier.** A source adapter beside gnumner's existing ones finds the classifier's
current link on gnumner.minfin.am, rather than hardcoding a file name that changes with every
update. It downloads the `.xls`, reads the code sheet (code, name, unit) and transcodes the names
from ArmSCII-8 font encoding stored as Latin-1, including byte 0xA8 for «և». Codes stored as
floats are zero-padded to 8 digits. TLS uses the intermediate certificate already in `certs/`.
`npm run cpv:refresh` is dry by default: it reports codes added, removed and renamed against the
stored version. With `--apply` it writes the new version in one transaction. A code the new file drops is marked
withdrawn rather than deleted, because inferred codes reference the table. A withdrawn code is
never a candidate. The refresh never touches stated or inferred codes on tenders. The e-auction classifier subset holds one code the full list lacks
(`44421700`), so the refresh merges the e-auction subset's extra codes in, marked as such.

**Which lots are coded.** At normalize time, every lot with a null stated code on a tender that
is biddable is a candidate, on every channel. Backfills and closed tenders are skipped. A lot
whose name changed in an amendment is re-coded. A lot that gains a stated code loses its inferred
code in the same write. Nothing is re-coded when the classifier or the model changes, except by
a deliberate script.

**How a code is chosen** (a pure service plus a repository for candidates):

1. Candidates: the codes of the most similar stated-code lots (trigram similarity on name), and
   the classifier entries whose names are most similar. At most a few dozen, each with its name,
   level, and how often buyers used it on similar lots.
2. The model (`claude-haiku-4-5`, through the existing AI adapter's structured-output call) gets a
   stable cached system prompt and, as data, the lot name, the tender's subject and the
   candidate list. It answers in a strict schema: a code from the candidates or `none`, a
   confidence, and a short reason. The system prompt says the lot text is data, not instructions.
3. The answer is validated in code. `stop_reason` is checked first, and a refusal means no code.
   The code must be in the candidates and in the classifier, or it is dropped. Below the
   confidence threshold fixed by the backtest, no code is written. Any level in the classifier is
   allowed (division, group, class or full code).
4. A refused, failed or `none` answer leaves the lot uncoded and counted as unclassified, with its
   reason.

**The no-model baseline** (`nearest`) is the code of the single most similar stated-code lot
above a similarity floor. It is built because the backtest needs it, and it stays available as
a method if the backtest shows the model does not earn its cost.

**Job and timing.** A new job name (a constant), on its own queue or on ALERTS' neighbour so a
slow model call can never hold back alert delivery, codes one tender's candidate lots. The
normalizer queues it after the tender is saved. Match runs immediately as it does today, so
keyword matches are never delayed. When inferred codes are written, the job re-runs the match
for the tender with `TenderIngested`, the same re-match ticket 25 does after a document set
lands. `notifications_dedupe_uq` silences what was already said. Job ids use hyphens. The AI
layer's rule holds: a throttled model call spends an attempt. On the last attempt the lots are
recorded unclassified (`rate_limited`, `ai_unavailable`), and ingestion is never failed.

**Readers that use inferred codes:** the matcher, the CPV and field filters and relevance read
stated ∪ inferred. `libs/cpv.js#tenderCodes` and its SQL twin `tenderCodesSql` gain the
inferred lot codes together, and must keep moving together. **Readers that never do:** every
intelligence query (benchmarks, buyer and supplier profiles, competitor prices, expected
competition, the price recommendation) and the amendment fingerprint. The fingerprint must not
read the inferred column, so a re-inferred code never raises an amendment or an alert.

**Alerts.** A match whose CPV reason comes only from an inferred code says so in its reasons,
and the Telegram, email and digest lines render it as "(inferred CPV)". No other change to the
message formats.

**API.** Tender detail and lots carry stated codes as today. Each lot adds `inferredCpvCode`
(null when stated or unclassified) and `cpvName` for whichever code it shows, read from the
classifier. Tender-level codes add `inferredCpvCodes` beside `cpvCodes`, never merged into it.
`docs/API_REFERENCE.md` documents the fields.

**Backtest.** `npm run cpv:backtest` hides a sample of stated-code lots, runs both methods
(`model`, `nearest`), and reports agreement at full code, group (5 digits) and division (2
digits), per purchase kind (goods, works, services), plus the share answered `none`. A `none`
is not counted as wrong; it is reported as coverage. Services and works come from ARMEPS's
labelled lots. If ARMEPS gives fewer than about 50 of either, the script writes a list of ~50
paper lots for the owner to label by hand and includes that labelled file in the next run.
**Gate:** alerts and filters read inferred codes only once the chosen method reaches ≥90%
division agreement on each purchase kind. Until then, inference may run and store codes, but
readers ignore them, behind a config flag read in the one config file.

**Cost.** Billed to Tendra. No `checklist_generations`-style quota, no tenant row. About 100
lots a day. The Batches API is a separate board task.

**The closed e-auction gap** is operational, not code: run `npm run documents:backfill` for
e-auction and report how many of the 385 archives were still downloadable.

**Documentation.** CLAUDE.md's *Current state* gains a bullet on inferred CPV codes: the
separate column, the readers that use it and the ones that never do, the classifier and its
refresh, and the gate. The ticket-17 bullet that lists "primary ∪ `cpv_codes` ∪ lot codes"
names the inferred lot codes too.

## Testing Decisions

**No automated tests are written in this slice.** There is still no test runner.

**The backtest is the verification**, as it is for relevance (`npm run relevance:backtest`). It
measures outward behaviour (the code a lot ends up with against the code its buyer gave) and
does not care how candidates were found or which prompt was used. It is run against the local
`tendra` database and its numbers are recorded in the ticket that sets the gate.

When tests arrive, the seams are:

- **The inference service, pure, with candidates and the model answer as inputs.** Assert the
  code written, or none, for: a valid pick, a code outside the candidates, a code outside the
  classifier, a refusal, low confidence, and a broader-level pick.
- **The normalizer plus the job against a real database, with the AI adapter faked.** Assert that
  a biddable paper lot gets an inferred code, a closed one does not, a stated code clears the
  inferred one, and an inferred code never changes `version`.
- **One narrow database check:** an inferred code on a lot that has a stated one is refused by
  the CHECK, and an inferred code not in the classifier is refused by the foreign key.
- **One intelligence check:** a benchmark computed with inferred-coded lots present equals the
  one computed without them.
- Prior art: the relevance backtest (method comparison against held-out real behaviour), and the
  checklist extractor's `verifyEvidence` (AI output validated in code, not trusted).

**Verification by hand**, recorded in each ticket:

- `cpv:refresh` loads 11,386 codes (plus the e-auction extra) with readable Armenian names;
  `32341334` reads «ալեհավաք»;
- a biddable paper tender's lots get inferred codes with provenance; a saved search on one of
  them alerts once, marked "(inferred CPV)";
- re-running the job sends nothing new and changes no `version`;
- the benchmark for a code is unchanged after inference ran.

## Out of Scope

- Inferring codes for closed tenders or history; inferred codes are never an intelligence input.
- A separate "category" or tag. A tender's field follows from its codes, as today.
- Escalation to a stronger model, and the Batches API (its own board task).
- Embeddings / `pgvector` similarity (its own board task); trigram similarity is the candidate
  search here.
- Automatic, scheduled classifier refresh; the refresh is hand-run.
- Classifier names in alert and digest messages beyond the "(inferred CPV)" marker.
- Copying any competitor's classification. HayTender was considered and not used: the official
  classifier is public, complete and carries no question of anyone's rights.
- Re-coding when the classifier or the model changes, other than by a deliberate script.

## Further Notes

- The 8.8% figure on the board is stale; the measured coverage is in the Problem Statement.
- The classifier's facts (Government decision 390-Ն of 13.04.2017, the gnumner XLS of 11.11.2026
  with 11,386 codes, ArmSCII-8 names, the national renumbering below class level) were found by a
  research pass on 2026-11-13. 2,392 of the 2,393 distinct stated lot codes in the local database
  are in it; the one missing, `44421700`, is in the e-auction subset.
- Below class level Armenia renumbered CPV: the same 8 digits often mean something else in EU
  CPV (03111200 is sugar beet here and peanuts there). EU CPV names must never label an Armenian
  code.
- ADR 0006 records why inferred codes come only from the national classifier, sit in their own
  column and never enter intelligence.
