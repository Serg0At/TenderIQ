# 02 — Candidates, the no-model method, and the backtest

**What to build:** For any lot, Tendra can list the candidate codes it could carry: codes
Armenian buyers put on similarly named lots, and classifier entries with similar names. It can
also infer a code without a model (`nearest`: the code of the single most similar stated-code
lot above a similarity floor). `npm run cpv:backtest` measures how often that agrees with the
buyer's own code, per purchase kind. This produces the baseline every later method is judged
against. Nothing is written onto real tenders yet. See `.scratch/cpv-inference/spec.md`, *How a
code is chosen*, *The no-model baseline* and *Backtest*.

**Blocked by:** 01 — The CPV classifier is loaded and names every code.

**Status:** done

- [x] `tender_lots` gains `inferred_cpv_code` (FK to `cpv_classifier`) and its provenance:
      method (`model` | `nearest`), model id (nullable), classifier version and inferred-at.
      A CHECK refuses an inferred code on a lot whose stated code is set. A trigram index on
      `tender_lots.name` is added. All of this goes straight into `create_table.js` /
      `drop_table.js`.
- [x] A repository returns a lot's candidates: the codes of the most similar stated-code lots
      (with how often each was used) and the most similar classifier names, at most a few dozen,
      each with name and level. A candidate is never drawn from the lot itself.
- [x] The `nearest` method lives in a pure service that takes candidates and returns a code or
      none.
- [x] `npm run cpv:backtest` holds out a sample of stated-code lots and reports agreement at
      full code, group (5 digits) and division (2 digits), plus the share answered none, **per
      purchase kind** (goods, works, services). None is reported as coverage, never as wrong.
- [x] Services and works come from ARMEPS's labelled lots. If either has fewer than ~50, the
      script writes a file of ~50 biddable paper lots (name, tender subject, empty code column)
      for the owner to label. A labelled file passed back in is included in the next run.
- [x] Verified by hand: the baseline's numbers per purchase kind are recorded in this ticket;
      the CHECK refuses an inferred code beside a stated one; the FK refuses a code outside the
      classifier.

## Done — 2026-11-13

Verified on the local `tendra` database (schema hand-`ALTER`ed in); the schema also on a
scratch database built from `create_table.js` and dropped with `drop_table.js`.

- **Schema.** `tender_lots.inferred_cpv_code` (FK to `cpv_classifier`), `inferred_cpv_method`,
  `inferred_cpv_model`, `inferred_cpv_classifier_version`, `inferred_cpv_at`. Four CHECKs:
  `…_stated_chk` (never beside a stated code), `…_method_chk` (`model` | `nearest`),
  `…_provenance_chk` (a code comes with method, version and time), `…_model_chk` (a model id
  iff the method is `model`). Provenance is free while the code is null, so ticket 04 can
  record an unclassified attempt where it likes. By hand on the scratch database: an inferred
  code beside a stated one → `tender_lots_inferred_cpv_stated_chk`; `99999999` → FK (on
  `tendra`, `99999999` is a real code, «դրամաշնորհային ծրագրեր», so `12345678` was used
  there → FK); a stated code arriving without clearing the inferred one → the CHECK, and with
  clearing it in the same write → accepted. **For ticket 04:** any writer that sets
  `cpv_code` on a lot holding an inferred code must clear it in the same `UPDATE`, or the
  CHECK throws.
- **The trigram index is on `left(name, 100)`, not the whole name.** A lot names its item
  first, and an e-auction lot then runs on into specification (median 95 characters, 1 in 10
  over 900). On whole names a search took ~1 s (the index returned 12,698 rows for «Բանան» and
  each was rechecked against its full text), and «Բանան» matched an event-organising lot whose
  spec mentions a fruit basket. On the head: ~150 ms.
- **Similarity** (`cpvCandidate.repo.js#similaritySql`) is the better of the whole heads'
  trigram similarity and that of their equal-length heads (each cut to the shorter one's
  length), so a short paper name finds the long lot that opens with it. Measured on 341
  held-out lots at floor 0.4 against similarity of the whole heads alone: division agreement
  within 4 points (ARMEPS goods 80% → 76%, e-auction goods 82% and ARMEPS services 86% both
  ways), up to 17 points more answered (ARMEPS goods 51% → 68%). The lot prefilter is only the
  GIN-servable operators (`%`, `name <% head`); "the lot opens the name" is not servable and
  cost a seq scan.
- **Candidates** (`cpvCandidate.repo.js#candidatesFor`): the codes of the 100 most similar
  stated-code lots, at most 20, each with `uses` (distinct tenders) and the best lot
  similarity; plus at most 15 classifier entries by name. Every code is `withdrawn_in IS
  NULL`; never an inferred code (a guess is never evidence for a guess); never the lot itself.
  Each carries name and level (`libs/cpv.js#cpvLevel`: division, group, class, category,
  code).
- **`nearest`** (`services/cpvInference.service.js`): the code of the most similar stated-code
  lot at or above `NEAREST_FLOOR` = **0.6**, ties to the code more tenders used, then the
  lower code. 0.5 → 0.6 lifts ARMEPS services' division agreement 89.6% → 93.2% for 7 points
  of coverage, goods do no worse, and above 0.6 services lose half their answers.
- **The backtest** holds out one lot per distinct (tender, name, code), excludes the lot's own
  tender and every tender of its reference code from the candidates, and draws by a seeded
  hash (`--seed`). Agreement is over lots answered; none is coverage.

### The baseline (`npm run cpv:backtest`, seed `cpv`, 1,007 lots, 15 min)

Division agreement and coverage at the production floor 0.6 (the full sweep 0.3–0.8 is in the
script's output):

| Kind | Held-out lots (tenders) | Answered | Code | 5-digit | 3-digit | Division | Stated code among candidates |
| --- | --- | --- | --- | --- | --- | --- | --- |
| goods — total | 449 (260) | 52.8% | 66.7% | 75.5% | 81.0% | **83.5%** | 73.3% (division 87.1%) |
| goods — ARMEPS | 149 (29) | 50.3% | 70.7% | 85.3% | 85.3% | 85.3% | 100% * |
| goods — e-auction | 300 (231) | 54.0% | 64.8% | 71.0% | 79.0% | 82.7% | 60.0% (division 80.7%) |
| works — ARMEPS | **11 (9)** | 63.6% | 71.4% | 71.4% | 71.4% | **71.4%** | 63.6% |
| services — ARMEPS | 110 (32) | 53.6% | 91.5% | 91.5% | 91.5% | **93.2%** | 67.3% (division 86.4%) |
| works — e-auction (outside the total) | 137 (33) | 26.3% | 88.9% | 88.9% | 88.9% | 88.9% | 35.0% |
| services — e-auction (outside the total) | 300 (193) | 27.3% | 79.3% | 84.1% | 86.6% | 89.0% | 49.7% |

What it says:

- **`nearest` does not reach the ≥90% division gate on goods** (83.5%) at any floor (best
  85.2% at 0.7, answering 46.5%). Services pass at 0.6 on 110 lots from 32 tenders. Works is
  **unmeasured**: ARMEPS holds 11 distinct labelled works lots (49 items from 9 tenders), so
  their 71.4% is 5 of 7 answered lots.
- **Coverage is about half.** A lot that is not answered sends no alert, which is the safe
  side, but it is the half the model has to win.
- **\* The candidate ceiling for ARMEPS is inflated.** ARMEPS lot names are very often the
  classifier name of the code they carry («ճանապարհների վերանորոգման աշխատանքներ» is
  45231177's name word for word), so the classifier-name candidates always contain the
  answer. For ticket 03 that makes ARMEPS goods an easy test for the model; e-auction (60%)
  and the hand-labelled paper lots are the honest ceiling. Paper names are short (median 15
  characters) and paper is what will be coded, so the labelled file matters.
- Paper's own stated codes are not a usable sample: 209 items from 5 tenders, 6 distinct, and
  paper states no purchase kind.

### The file to label

ARMEPS gave fewer than 50 works lots, so the script wrote
`.scratch/cpv-inference/paper-lots.csv`: 50 paper lots (32 whose lot or tender says
«աշխատանք», pre-filled `kind = works`; 18 more with `kind` blank), one per distinct name,
current runs, newest first. Fill `code` (8 digits, in the classifier) and correct or fill
`kind` (`goods` | `works` | `services`). The next `npm run cpv:backtest` reads it (or
`--labelled=<file>`), includes every row with a code under its kind as "paper (labelled)",
and reports rows it could not use. It is never overwritten. Services did not ask for labels
(110 ARMEPS lots); local `tendra` stopped ingesting on 11-05, so only 22 paper lots were
still biddable today and the file draws on every current paper run, each biddable when it
was ingested.
