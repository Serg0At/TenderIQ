# Relevance ranking — order biddable tenders by fit to the organization

Board task: `FR-DISC-4 · Rank tenders by relevance to an organization's profile/history (P1)`.
Decisions recorded in [ADR 0003](../../docs/adr/0003-relevance-ranks-on-cpv-not-ai.md) and in the
Discovery section of [CONTEXT.md](../../CONTEXT.md).

## Problem Statement

A supplier opens Discovery and sees every tender, newest first. About 148 are biddable at any
moment, across 30 CPV divisions — furniture, fuel, medical consumables, road repair — and a
medical supplier has to read past all the asphalt to find the three tenders that are theirs.
Filters help only if they already know exactly what to type, and typing the wrong keyword hides
work they would have won. Missed tenders are this product's #1 churn cause.

The irony is that the system already knows who they are. It holds every bid they ever placed, at
which buyer, in which category, and whether they won. It knows which tenders they pursued and
which they dismissed. None of that reaches the list they look at every morning: the ordering is
the same for a hospital supplier and a road builder.

A scoring function does exist — `matcher.service.js` — but it answers one narrow question: does
this tender clear one saved search's threshold, so should an alert fire? It is per search, not per
organization; binary, not graded; and it never touches the ledger. It cannot order a list.

## Solution

A second list beside Discovery: the same biddable tenders, ordered by how well each one fits this
organization.

The main list is untouched — `GET /tenders` stays newest first for everyone, and `GET
/tenders/relevant` is the list a supplier chooses. It covers only tenders they could still bid on,
best fit first, weakest last. Nothing is hidden: a tender nothing matches sits at the bottom, not
outside.

Fit is read from what the supplier actually does, not only what they claim. First, their public
bid record: the categories they win in, the categories they bid in, and the buyers they are known
at. Then their own pipeline: tenders they pursued, and — pushing the other way — tenders they
looked at and dropped. Then their claims: their saved searches and their field.

Every row explains itself. Each carries a band — strong, moderate or weak — and structured reasons
naming the evidence ("exact CPV match on lot 7", "you won 3 lots at this buyer"). The exact score
travels in the response for tooling but no screen shows it, because a number out of one has no
units and invites an argument no one can win.

An organization with nothing to rank on is told so rather than handed an invented order: an empty
list naming exactly what is missing, so the client can offer the buttons that fix it.

## User Stories

### Seeing the ranked list

1. As a supplier, I want a list of tenders ordered by how well they fit my company, so that I can
   stop reading past categories I have never sold into.
2. As a supplier, I want that list to contain only tenders I could still bid on, so that I am not
   reading a multi-year archive when I am looking for this week's work.
3. As a supplier, I want the plain Discovery list to stay newest-first, so that the view I already
   use does not change under me when this feature ships.
4. As a supplier, I want the relevant list to be a deliberate choice I make, so that I can switch
   between "what is new" and "what is mine".
5. As a supplier, I want tenders that fit nothing to appear at the bottom rather than vanish, so
   that the ranking never hides a tender from me.
6. As a supplier, I want the ordering to cover every biddable tender rather than a top ten, so
   that paging to the end is possible when I am doing a thorough sweep.
7. As a supplier, I want a tender with no deadline to still appear, so that a notice missing one
   field is not silently dropped.
8. As a supplier, I want equally-fitting tenders ordered by which closes first, so that the one I
   must act on today is above the one closing next month.
9. As a supplier paging through the list, I want each page to continue where the last ended, so
   that no tender is shown twice or skipped.

### Understanding why something is ranked where it is

10. As a supplier, I want each tender labelled strong, moderate or weak fit, so that I can tell
    whether anything here is worth my morning.
11. As a supplier, I want to see the reasons behind a ranking, so that I can judge whether the
    system understood my business.
12. As a supplier, I want a reason to name the evidence rather than assert a verdict, so that I can
    check it against the tender myself.
13. As a supplier, I want a reason to name the specific lot that matched, so that I know which part
    of an 18-lot procurement concerns me.
14. As a supplier whose whole list is weak, I want every row to say so, so that a bad week looks
    like a bad week instead of the top row looking like a win.
15. As the product, I want the numeric score available in the response but absent from the screen,
    so that tuning and support have the number while users are not handed a false precision.
16. As a frontend developer, I want reasons delivered as codes and values rather than English
    sentences, so that I can write them in Armenian without a second translation layer.

### Ranking on bid history

17. As a supplier who has bid before, I want the categories I actually bid in to drive my ranking,
    so that the system knows my business even if I never configured anything.
18. As a supplier, I want the categories I have *won* in to count for more than the ones I merely
    bid in, so that my strongest line of business ranks highest.
19. As a supplier, I want a buyer I have bid at before to lift a tender slightly, so that a
    relationship I have already built counts for something.
20. As a supplier, I want a tender matching several of my signals at once to outrank one matching a
    single signal, so that the obvious best fit of the day reaches the top.
21. As a supplier whose business has changed, I want recent history to count for more than old
    history, so that the trade I left behind three years ago does not shape today's list.
22. As a supplier, I want old history to still count a little rather than disappear, so that a
    long-standing category I bid in twice a year is not forgotten.
23. As a supplier who lost a tender, I want that loss not to push similar tenders down, so that the
    categories I compete in hardest are not buried — losing means I compete there.
24. As a supplier who has claimed no supplier identity, I want the ranking to work from whatever
    else it has, so that the feature degrades rather than refusing to run.

### Ranking on pipeline history

25. As a supplier, I want tenders similar to ones I have pursued to rank higher, so that this
    week's list reflects what my team is actually working on.
26. As a supplier, I want tenders similar to ones I explicitly dropped or marked no-go to rank
    lower, so that telling the system "not for us" means something.
27. As a supplier, I want tenders I am already tracking to appear in their normal position, so that
    the list does not hide work in progress.
28. As a supplier, I want a tracked tender marked as such in the list, so that I can see at a
    glance that my team is already on it.
29. As a supplier, I want a tracked tender not to be artificially boosted, so that the list keeps
    telling me something I did not already know.

### Ranking on saved searches and field

30. As a supplier with saved searches, I want them to contribute to my ranking, so that the
    keywords I took the trouble to configure are not ignored outside alerts.
31. As a supplier, I want my saved searches to count for less than my actual bid record, so that
    something I typed once does not outweigh forty tenders I bid on.
32. As a supplier, I want tuning the ranking never to change which alerts I receive, so that my
    alert stream stays stable when this feature is adjusted.
33. As a new organization, I want to choose my field from a list, so that the product can rank for
    me before I have any history.
34. As a supplier selling across categories, I want to choose more than one field, so that my
    office-supplies and furniture work both count.
35. As a supplier, I want a limit on how many fields I can claim, so that the list stays meaningful
    rather than matching everything.
36. As an owner, I want to change my organization's field after creation, so that a wrong choice at
    sign-up is not permanent.
37. As a founder, I want the field to be optional when I create my organization, so that sign-up
    stays one screen.

### When there is nothing to rank on

38. As a brand-new organization, I want to be told that relevance needs something from me rather
    than shown a fabricated order, so that I can trust the ranking when it does appear.
39. As a brand-new organization, I want to be told exactly what is missing — a field, a saved
    search, a supplier identity — so that the screen can offer the right buttons.
40. As a brand-new organization, I want that answer to be an ordinary successful response rather
    than an error, so that the client renders a helpful screen instead of a failure.
41. As a supplier with no basis yet, I want to be pointed at plain filters in the meantime, so that
    I can still narrow the list by hand.

### Filters

42. As a supplier, I want to combine the ranking with filters, so that I can ask for the best fits
    at one buyer or above a value.
43. As a supplier, I want to filter tenders by whether they buy goods, works or services, so that a
    services company is not reading through equipment purchases.
44. As a supplier, I want to filter tenders by field, so that someone with no history can narrow to
    their industry in one click.
45. As a supplier, I want those filters available on the plain Discovery list too, so that they are
    not locked behind a paid feature.

### Plan and access

46. As the business, I want the relevant list gated at `pro` and above, so that the ranking is a
    reason to upgrade.
47. As a free-plan supplier, I want a clear upgrade answer rather than a broken screen, so that I
    know the feature exists and what it costs.
48. As a member of any role, I want to read the relevant list if my organization's plan allows it,
    so that a viewer researching tenders is not blocked by a permission.
49. As a supplier, I want the ranked list to be about my organization and nobody else's, so that
    my pipeline and pursuit history never inform another tenant's ordering.

### Learning whether the ranking is any good

50. As the product, I want the relevance score and reasons recorded when a tender is tracked, so
    that I can later ask whether highly-ranked tenders turn into pursuits and wins.
51. As the product, I want that record written at the moment of the decision rather than
    recomputed later, so that it reflects what the supplier actually saw.
52. As a developer, I want to replay the ranking against history and measure where real bids
    landed, so that the weights are chosen by evidence rather than taste.
53. As a developer, I want the recency window to be a single configurable value, so that the
    backtest can sweep it instead of me guessing.
54. As a developer, I want the ranking to run fast enough for a list request, so that the feature
    does not need a cache before it has a user.

## Implementation Decisions

### Vocabulary

**Relevance** is a graded fit between a biddable tender and an organization; it orders lists.
A **Match** is a saved search clearing its threshold; it fires alerts. They stay separate concepts
sharing code, so changing relevance weights can never change which alerts fire. **Field** is the
organization's industry (`organizations.type`); **Purchase kind** is the tender's goods / works /
services label. Definitions are in `CONTEXT.md`.

### The ranking function

A new service module holds the whole ranking rule as a pure function, in the shape
`matcher.service.js` already establishes: no Knex import, no queue, no clock of its own. It takes
candidate tenders, the organization's signal bundle, and a `now`, and returns the ordered rows
with score, band and reasons.

Scoring is additive with diminishing returns, so several medium signals beat one. Signal strength,
strongest first:

1. **Won in a similar category**, strongest at the same buyer.
2. **Bid in a similar category** (public ledger), or **pursued** a similar tender.
3. **Saved search match.**
4. **Field match.**
5. **Known buyer** — bid there before, different category.

Negative: a tender similar to one the organization **dropped** or marked **no-go** scores lower.
A **loss** is not negative — competing in a category is relevance; whether they can win it is the
intelligence layer's question.

### Similar category means the CPV hierarchy

Similarity is decided by CPV: exact code, then 3-digit group, then 2-digit division, weakening at
each step — the hierarchy `matcher.service.js` already implements for saved searches. Measured on
the live corpus, 147 of 148 biddable tenders carry a CPV code on at least one lot, because the
invitation archive is fetched for current tenders. ADR 0003 records why this beats AI here.

Rarity-weighted word overlap over titles and lot names is the fallback for a tender with no CPV,
and lives in its own module rather than inside the scorer: lot text averages 3,000 characters and
is often `տես կից ֆայլը` or a whole specification paragraph, so common words must count for
nothing.

A tender is scored on its **best-matching lot**, and the reason names that lot. Averaging across
lots would bury the 18-lot procurement whose lot 7 is the supplier's category — the same rule
Discovery's CPV filter already follows.

### Recency

History never expires; recent history simply weighs more, in steps rather than a curve so a
ranking can be reproduced by hand. The full-weight boundary is a single configuration value the
backtest sweeps. Starting point: full weight within 12 months, half to 36 months, quarter beyond.
Suppliers bid rarely — the median supplier in the ledger has bid on one tender in two months — so
a short window starves the signal rather than sharpening it.

### Candidates, ordering and paging

Candidates are biddable tenders: `is_latest`, status `active` or `amended`, deadline in the future
or absent. An explicit status filter from the caller wins. Ordering is score descending, then
deadline ascending with no-deadline last, then `id`. Cursor-based paging as everywhere else, the
cursor encoding the full sort key; default page size 20, cap 100. Filtering happens in the query,
never in a parser.

### Where the score is computed

At request time, over roughly 148 candidates, with the organization's signal bundle loaded once by
a repository. No stored score table and no worker: a stored score would be stale the moment an
organization claims its supplier identity, and the candidate set is small enough that the pure
function is cheap. If the list misses the 1.5s P95 budget, a cache keyed on organization and
signal version is the next step — measured, not pre-emptive.

### API contract

`GET /api/v1/tenders/relevant`, mounted before `/tenders/:id`. It is the first org-scoped read
under `/tenders`, so the service takes the organization explicitly rather than inheriting the
public corpus path's tenant-free assumption. Gates: authenticated, `tender:read`, plan-gated on a
new `relevance` feature key entitled from `pro` upward. Because no subscription writer exists yet,
every organization currently reads `free` and this endpoint answers `PLAN_UPGRADE_REQUIRED` for
everyone — the same knowing state invitations are in.

It accepts the Discovery filter vocabulary — keyword, buyer, value range, purchase kind, field —
with status fixed to biddable. Each row carries the existing tender shape plus a relevance object
holding the numeric score, the band, the structured reasons, and the tracking state of that tender
for this organization.

Reasons are structured — a stable code plus values — never prose, so the client writes the
Armenian.

With no basis to rank on (no saved search, no pursuit history, no supplier identity, no field) the
endpoint returns 200, an empty list, and metadata naming the basis as insufficient and listing
what is missing. This follows `/tracked-tenders/performance`, which already answers
`insufficient_data` with a 200 rather than an error envelope.

### Field

`organizations.type` becomes a **Field**: chosen from a fixed list rather than typed, up to three
per organization, optional at creation and editable afterwards through a new organization-update
endpoint gated on `org:manage` — no such endpoint exists today.

The list lives in code as one constant, each field naming the CPV divisions (or 3-digit groups
where a division would otherwise sit in two fields) it covers. That one constant serves both the
relevance signal and the `filter[field]` query. Draft list: Furniture & furnishings (39) · IT &
telecom (302, 48, 72, 32) · Medical & pharmaceutical (33, 85) · Fuel & energy (09) · Electrical &
lighting (31) · Construction & renovation (45, 44) · Vehicles & transport (34, 60) · Professional
services (79, 71, 73, 66) · Industrial machinery (42, 43, 16) · Laboratory & measuring (38) ·
Chemicals & cleaning supplies (24) · Office equipment & stationery (301, 22) · Food & catering (15,
03, 55) · Cleaning, security & facilities (90, 98) · Education & training (80) · Textiles &
workwear (18, 19) · Other.

Storing several fields means `organizations.type` becomes an array column, matching
`saved_searches.cpv_codes`. Since the live database already holds organizations, this is the
additive-script workflow from CLAUDE.md — write it, run it, mirror it into the full-schema
migration, delete the script.

### Purchase kind filter

`tenders.goods_works_services` is already written for every tender by the detail parser and has no
filter. It gains `filter[purchaseKind]` on both tender lists. It is coarse — 373 goods, 47
services, 9 works in the current corpus — which is exactly why it belongs as a filter and not as a
relevance signal.

### Recording what was shown

When a tender is tracked, the relevance score and reasons as the supplier saw them are stored on
the `tracked_tenders` row. One write per human decision, and the only record connecting a ranking
to what somebody did about it. Nothing else is persisted: writing a row per candidate per request
would be ~148 writes a page view, stale on the next signal change.

### Region is not a signal

`parties.region` is empty for all 128 parties — the normalizer never passes it — so region cannot
contribute, and the existing saved-search region filter is already a silent no-op. Out of scope
here, worth a separate ticket.

## Testing Decisions

**No test runner is being added.** `tests/` is empty, `devDependencies` holds only nodemon, and the
project is deliberately staying there for now. Nothing in this spec should be blocked on choosing
one.

What stands in for tests:

- **The ranking function is pure** — candidates, signal bundle and `now` in; an ordered list out.
  No Knex, no clock, no HTTP. That is the seam a test suite would attach to, and keeping the shape
  costs nothing today while making the suite a later afternoon's work rather than a refactor. It
  is also what makes the backtest possible at all.
- **The backtest is the verification**, and it is a script under `src/scripts/` beside
  `exportProspects.js`, not a test. It takes real suppliers from the public ledger, hides their
  bids after a chosen date, ranks the tenders that were biddable on that date using only their
  earlier history, and reports where their actual bids landed. A ranking that puts real bids in the
  top ten works; one that does not gets its weights changed before a customer sees it. It is run by
  hand, prints numbers, and asserts nothing.
- **The backtest needs the archive, and nothing else does.** The database currently holds two
  months — 429 tenders, a ledger of 188 tenders, a median supplier with one bid. Every code path
  can be built and exercised at that size, so the backfill is sequenced late, immediately before
  the backtest it exists for. Expect the ledger signals to look underwhelming until then; that is
  a data state, not a tuning signal.
- **Checked by hand against the live database** for the rest: that the biddable candidate set is
  the ~148 rows expected, that a known supplier's ranking reads sensibly, and that the endpoint's
  P95 is inside the 1.5s budget before any cache is considered.

When a runner is eventually chosen, the first three suites the reference spec asks for are
cross-tenant denial, intelligence correctness, and a listing-parser fixture test — the ranking
function would join them as a fourth, needing no fixtures of its own.

## Out of Scope

- **AI anywhere on the request path.** Per-organization model judgement was costed at roughly
  $1,500–7,500/month and rejected; see ADR 0003.
- **Tagging the archive with AI.** A one-off Haiku batch assigning CPV divisions to archive tenders
  that lack them (~$17–33) is the follow-up if, and only if, the backtest shows history is too thin
  without it.
- **Embeddings and semantic similarity.** V2/V3 in the reference spec, and unnecessary while CPV
  covers 147 of 148 biddable tenders.
- **Changing the default order of `GET /tenders`.**
- **Changing alerts.** `matcher.service.js`, `MATCH_THRESHOLD` and the alert pipeline are untouched.
- **A stored score table, a precompute worker, or a cache.** Request-time only until measurement
  says otherwise.
- **Buyer region**, which has no data behind it.
- **Armenian wording.** The API emits reason codes; copy arrives with the frontend.
- **A per-user ranking.** Relevance is per organization; a tenant's members all see one order.

## Further Notes

**Why this feature exists where it does.** The reference spec lists relevance under Discovery, the
free tier's hook, but the signals that make it work — the public ledger, win history — are
intelligence data. Hence the split: the list is plan-gated at `pro`, while the two filters it
leans on stay free.

**The marketing copy says "Relevance ranking 🤖".** V1 is deterministic, and that is a better
product here: it is explainable, free to run, and cannot invent a fit. Either the copy changes or
the archive-tagging batch becomes the AI it refers to. Flagged rather than silently contradicted.

**The ledger is thin until the backfill runs.** 361 suppliers, a median of one tender bid on, 68
suppliers with five or more. Weights tuned against two months of data would be tuned against noise.

**A stale comment to fix in passing.** `prospectScoring.service.js` says CPV "is always null in the
live schema today". That has not been true since the invitation stage shipped; `profile.repo.js`
says "roughly a third", which is right for the archive and understates current tenders at 147/148.

**Order of work.** The two schema-light pieces first (purchase-kind filter, then the field list
with the organization update and the field filter), then the prefactor that gives alerts and
relevance one CPV rule, then the endpoint end-to-end on its weakest signals, then the ledger and
pipeline signals that deepen it, then the text fallback and the record-on-track. The backfill and
the backtest come last, together: the measurement that decides whether the weights stand needs
history, and nothing before it does.
