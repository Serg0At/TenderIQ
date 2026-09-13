# 01 — Group matches per organization before raising the alert

**What to build:** When a tender matches several of one organization's saved searches, the
organization gets one alert that names every search that matched and goes to every channel those
searches ask for. Today the first matching search decides both, and the others are dropped without
a trace.

**Blocked by:** none.

**Status:** done

## Why

`handleTenderMatched` in `src/workers/matcher.js` loops over saved searches one at a time and calls
`notifications.createIfNew` per matching search. Alerts are deduplicated on
`(organization_id, type, tender_id, subject_id)` by `notifications_dedupe_uq`, so a second matching
search in the same organization gets `created: false` and `continue`s. Two things are lost:

1. **Which searches matched.** Saved searches now carry a `name` (commit `3156757`), but naming the
   match from inside this loop would name whichever search `listAll()` happened to return first.
   With two matches, the alert would say "matched *IT hardware*" when "*Servers — Yerevan*" matched
   too, and possibly scored higher.
2. **Channels.** `channels` is read from that same first search. If search A names `['telegram']`
   and search B names `['email']`, the tender reaches Telegram only. B's email is never attempted,
   and no `alert_deliveries` row records that it was skipped.

Deduplication is correct and stays. The fix is to decide per organization, not per search, *before*
the notification is created.

## Shape

- Score every search as today, then group the matches by `organization_id`.
- One `createIfNew` per organization, with a payload that carries every match:
  `matchedSearches: [{ id, name, score, reasons }]`, ordered by score descending with `id` as the
  tiebreaker so the order is stable. The existing top-level `score` / `reasons` become the best
  match's, so current readers of the payload keep working.
- Channels are the union of the matched searches' `channels`. If **any** matched search has an
  empty list, include `channelsForOrg(organizationId)`: an empty list means "however this
  organization can be reached", and another search naming a specific channel must not narrow that.
- Match against the name as it is at match time. The payload is the notification's record, so a
  search renamed later does not rewrite past alerts.

## Acceptance

- [x] A tender matching two searches in one organization creates exactly one notification, whose
      payload lists both searches by name, best score first.
- [x] That alert is sent on the union of the two searches' channels; each channel sends once, not
      once per search.
- [x] If one matched search has `channels: []` and another has `['email']`, the alert goes to every
      channel the organization has linked, not only email.
- [x] Two organizations whose searches match the same tender each get their own alert, unaffected
      by each other.
- [x] Re-running the matcher for the same tender and event sends nothing; the dedupe guarantee
      is unchanged.
- [x] The Telegram and email `tender-match` / `amendment` messages show the matched search names
      (e.g. "Matched: Servers — Yerevan, IT hardware"). An older notification with no
      `matchedSearches` still renders.
- [x] The job's return value still reports `matched` / `delivered` / `deferred`. `matched` counts
      matching searches, and a new `notified` counts organizations alerted, so a log line cannot
      overstate how many alerts left.

## Out of scope

- Personal, per-user delivery. Alerts stay organization-wide.
- Letting searches in one organization produce separate alerts for the same tender. That would
  re-introduce the duplicate alerts BR-9 forbids.
- The stale "deferred to quiet hours" wording in `matcher.js` comments and logs (quiet hours were
  removed). Fix it in passing if the lines are touched anyway.
