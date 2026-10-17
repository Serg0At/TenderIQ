# 09 — Remember what the ranking said when someone acted on it

**What to build:** When a supplier tracks a tender, the relevance score and reasons they were
looking at are stored on that pursuit.

This is the only record that connects a ranking to a human decision, and it is the data that
answers the question the feature will eventually be judged on: do highly-ranked tenders turn into
pursuits, and do those pursuits turn into wins? Without it, every future tuning argument is taste
against taste.

It must be the score **as shown at that moment**, not one recomputed later: the organization's
history changes constantly, so a recomputed number would describe a ranking the supplier never
saw. Equally, nothing else is persisted — writing a row per candidate per request would be ~148
writes for every page view, stale on the next bid.

A tender tracked from somewhere other than the relevant list simply has no score recorded, and
that absence is honest rather than backfilled with a guess.

**Blocked by:** 05.

**Status:** done

- [x] Tracking a tender from the relevant list stores the score and reasons that were shown.
- [x] The stored value is the one computed for that request, never recomputed afterwards.
- [x] Tracking a tender outside the relevant list records no score, and the pursuit works exactly
      as before.
- [x] The stored score is visible when reading the pursuit back, so the question can be asked
      without a database session.
- [x] Nothing else about the pursuit's behaviour, state machine or submit lock changes.
- [x] The schema change follows the additive-script workflow in CLAUDE.md, is mirrored into the
      full-schema migration, and the script is deleted once applied.
