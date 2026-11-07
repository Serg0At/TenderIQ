Status: ready-for-agent

# Daily digest — one morning message per daily destination

Board task: `Daily digest job — paired with instant alerts in the feature list` (P0; the
reference spec's Feature List row "Instant + daily digest"). Decided in a grilling session on
2026-11-07. The terms Destination, Cadence and Digest are in CONTEXT.md; Match, Saved search,
Relevance and Biddable tender were already there.

## Problem Statement

Every matched tender reaches every one of an organization's destinations the moment it is
ingested, one message each. On a busy day a supplier whose saved searches are broad gets dozens
of separate emails, and the usual response to an alert stream that is too loud is to stop
reading it, or to switch the channel off, at which point Tendra stops telling them about tenders
at all. Missed tenders are the #1 churn cause, so an alert stream that people mute defeats the
product's purpose.

There is no way today to say "send me these once a day". Telegram, where a message is a glance,
suits instant alerts; a mailbox suits a single morning summary. The reference spec pairs the two
("Instant + daily digest", P0), and only the instant half exists.

## Solution

Each destination has a **cadence**: `instant` or `daily`. A daily destination does not receive
new matches one by one. They are held, and at **08:00 Asia/Yerevan every day** it receives one
**digest** listing every match held for it since its last one. A day with nothing held sends
nothing.

Only new matches wait. Amendments, deadline reminders and countdowns, vault expiry, team
announcements and subscription notices still go out immediately to every destination whatever
its cadence, because they are rare and some of them are urgent: a deadline moved earlier must
not be learnt about the morning after it passed.

The digest is one list, the same tenders instant alerts would have sent and never more. Tenders
still accepting bids come first, soonest deadline first; tenders that have closed, been cancelled
or been amended since they matched are still listed, after them, each marked with one word, and
the link shows what happened. At most 20 tenders are listed, followed by "…and N more".

New Telegram destinations are `instant` and new email destinations are `daily`. Only a
destination's owner can change its cadence.

## User Stories

1. As a supplier, I want my email alerts to arrive as one message each morning, so that my inbox
   is not flooded on busy days and I keep reading them.
2. As a supplier, I want my Telegram alerts to stay instant by default, so that the channel I
   glance at all day keeps telling me about tenders as they appear.
3. As a supplier, I want to switch my own destination between instant and daily, so that I can
   pick the rhythm that suits how I work.
4. As a supplier, I want new email destinations to start as daily without my doing anything, so
   that the quiet setting is the one I get unless I ask otherwise.
5. As a supplier, I want a daily Telegram chat to be possible too, so that I can get one morning
   message in Telegram if that is where I read.
6. As a supplier, I want the digest at 08:00 Yerevan time, so that it is waiting when the
   working day starts.
7. As a supplier, I want a digest on weekend days that had matches, so that a tender published
   on Saturday with a Monday deadline is not missed.
8. As a supplier, I want no digest on a day nothing matched, so that an empty message does not
   train me to ignore the real ones.
9. As a supplier, I want the digest to list exactly the tenders an instant alert would have sent
   me, so that switching to daily never costs me a tender and never pads the list.
10. As a supplier, I want each tender to appear once even if it matched several of my
    organization's saved searches, so that the list is not repetitive.
11. As a supplier, I want each line to name the saved searches the tender matched, so that I
    know why it is there.
12. As a supplier, I want tenders I can still bid on listed first, soonest deadline first, so
    that the most urgent work is at the top.
13. As a supplier, I want each line to show the title, the buyer, the budget, the deadline and a
    link, so that I can decide whether to open it without opening it.
14. As a supplier, I want a tender that was cancelled, closed or amended after it matched still
    listed, marked with one word, so that I know it existed and why I should not plan on it as
    first announced.
15. As a supplier, I want cancelled and closed tenders after the biddable ones, so that dead
    tenders do not push live ones out of the list.
16. As a supplier, I want each tender shown as it is at 08:00, with its current deadline, so
    that the digest never shows a deadline that has since moved.
17. As a supplier on a busy day, I want at most 20 tenders and a count of the rest, so that the
    message stays readable and fits in Telegram.
18. As a supplier, I want an amendment to a tender I matched or am tracking to arrive
    immediately even though my destination is daily, so that a deadline moved earlier is not
    learnt about too late.
19. As a supplier, I want deadline reminders and countdowns to arrive immediately on a daily
    destination, so that "submit today" is not delivered tomorrow.
20. As a supplier, I want vault expiry alerts, team announcements and subscription notices to
    arrive immediately on a daily destination, so that rare messages are not delayed for no
    gain.
21. As a supplier switching from daily to instant during the day, I want the matches already
    held for me sent at once as one digest, so that switching never loses them.
22. As a supplier switching from instant to daily during the day, I want the next digest to hold
    only matches that arrive after the switch, so that I am not told twice about tenders I
    already received.
23. As a supplier, I want a digest that failed at 08:00 retried with the same tenders, so that
    a provider outage neither drops nor duplicates part of my list.
24. As a supplier whose email provider throttled the digest, I want it retried after the
    provider's delay without counting as a failure of my address, so that a busy morning does
    not revoke a working destination.
25. As a supplier whose destination was switched off and later switched back on, I want to
    receive matches from the moment it came back on, not a backlog of everything since it went
    off, so that the first digest is not a month of stale tenders.
26. As a supplier, I want every digest email to carry the unsubscribe link and headers instant
    alert mail carries, so that I can stop it the same way.
27. As a supplier, I want `/stop` in Telegram to stop a daily chat the same way it stops an
    instant one, so that there is one way to say stop.
28. As an owner or admin, I want to see each destination's cadence in the integrations listing,
    so that I can tell why a colleague receives a morning summary rather than live alerts.
29. As an owner or admin, I want to be unable to change a colleague's cadence, so that I cannot
    turn their private chat or personal inbox into a stream of instant messages they did not
    choose.
30. As an owner or admin, I want to still be able to switch a colleague's destination off, so
    that switching off stays organization-scoped as it is today.
31. As a supplier on the free plan, I want the digest, so that the plan that includes alerts
    includes both cadences of them.
32. As a member of an organization with only daily destinations, I want the delivery record to
    say a match is held for the digest, so that support never reads "email alerts are not
    switched on" for an organization whose email is on.
33. As the product owner, I want a held match to become `sent` when its digest goes out, so
    that "was this supplier told about tender X, and how" is one row I can query.
34. As the product owner, I want held matches of a destination that is switched off before its
    digest recorded as `skipped` with a reason, so that the record stays honest about what
    never left.
35. As the product owner, I want the digest to be sent through the same delivery policy as
    instant alerts, so that throttling, failure counting, revocation and the `log`-driver guard
    behave identically and there is no second answer to "deferred or failed".
36. As the product owner, I want two runs of the digest job on the same morning to send one
    digest per destination, so that a re-run scheduler or a retried job cannot double-send.
37. As the product owner, I want each delivery row to name the destination it went to, so that
    a delivery can be traced to one person's chat or address instead of only to a channel.
38. As the product owner, I want relevance never to add a tender to a digest, so that the
    boundary that relevance orders a list and never decides an alert still holds.

## Implementation Decisions

**Vocabulary.** A destination is one `channel_subscriptions` row. Cadence is a property of that
row. A digest is a message to one destination, not to an organization.

**What is held.** Only notifications of type `tender-match` are held for a daily destination.
Every other type — `amendment`, `reminder-*`, `countdown-*`, vault expiry, team announcements,
invitations, subscription-ending — is delivered immediately to every destination regardless of
cadence. Relevance plays no part in what is held or listed.

**Schema** (straight into `create_table.js` / `drop_table.js`, per the no-additive-scripts rule):

- `channel_subscriptions.cadence` — text, NOT NULL, CHECK `cadence IN ('instant', 'daily')`.
  No database default: the repository sets it when a destination is created, `instant` for
  Telegram and `daily` for email, so a forgotten value fails the insert instead of silently
  becoming instant.
- `channel_subscriptions` gains `UNIQUE (id, organization_id)` so a child can anchor to it.
- `alert_deliveries` gains `organization_id` (NOT NULL) and `channel_subscription_id`
  (nullable — a `skipped` row for a channel with no destination, a `log` row and a
  misconfigured-channel row name none). Following the tenant-isolation rule, both parents are
  reached through composite foreign keys: `(notification_id, organization_id)` to
  `notifications (id, organization_id)` and `(channel_subscription_id, organization_id)` to
  `channel_subscriptions (id, organization_id)`, with no single-column FK beside them. The
  destination key is `ON DELETE SET NULL (channel_subscription_id)`, so deleting a destination
  keeps the delivery history; `notifications` gains `UNIQUE (id, organization_id)` for the
  first key.
- `alert_deliveries.status` gains the value `held`. A partial index on
  `(channel_subscription_id) WHERE status = 'held'` serves the digest's read.
- The stale quiet-hours comment on `alert_deliveries.deferred_until` is corrected while the
  table is touched.

**The held rows are the cursor.** A destination's next digest is exactly its `held` rows; no
"covered until" timestamp is stored. This gives the decided behaviour directly:

- instant → daily: rows written before the switch were `sent`, so they are never repeated;
- daily → instant: the held rows are flushed at once as one digest (a digest job queued for
  that destination on the switch);
- a failed or throttled digest leaves its rows `held`, so the retry sends the same tenders;
- switching a destination off (every revoke path — the API, `/stop`, the unsubscribe link,
  auto-revocation after repeated failures) turns its `held` rows into `skipped` with the detail
  "destination switched off before its digest", inside the repository's revoke so no path can
  forget it; switching back on therefore starts empty, with no backlog.

**Instant delivery path (notifier).** `deliver` already loops over an organization's
deliverable destinations and writes one `alert_deliveries` row per destination. For a
`tender-match` notification and a `daily` destination it now writes a `held` row naming the
destination and sends nothing. The channel-level result gains `held` (none sent, none
deferred, at least one held), beside `sent` / `deferred` / `skipped` / `failed`; a mix with any
`sent` is still `sent`. The "no recipients" `skipped` row stays exactly as it is and is now only
ever written when the channel truly has no live destination. Every row written by `deliver`
records its destination.

**Digest job.** Two job names, constants in the queue names file, on the ALERTS queue:

- `digest.daily` — a repeatable job registered by the scheduler, cron `0 8 * * *` in
  `Asia/Yerevan`. It finds every live destination with at least one `held` row and queues one
  `digest.send` per destination.
- `digest.send` — one destination's digest. Job id `digest-{destinationId}-{Yerevan date}` for
  the morning run, so a re-run on the same morning is a no-op; a flush on a cadence switch uses
  its own id with the switch time. Hyphens only (BullMQ rejects ids with more than two `:`).

`digest.send` reads the destination's `held` rows, renders one message, and sends it through
the channel's transport with the same outcome policy as an instant alert (`applyOutcome`):
`sent` → every row in the digest becomes `sent` with `sent_at`; throttled → rows stay `held`
and the job is delayed by the provider's retry-after without spending an attempt; permanent
failure / auth / invalid → rows become `failed` with the detail, and the failure counter and
revocation behave as for an alert; the `log` driver outside development is a `failed`, as for
an alert. A destination revoked between `digest.daily` and `digest.send` sends nothing.
Delivery is at-least-once, as instant alerts are today: a crash between the send and the row
update can resend that digest once.

**Content.** Rendered from the tenders as they are at send time (the latest version), not from
the notification payloads, so deadlines and statuses are current; the matched saved-search
names come from each notification's `matchedSearches` payload (the names at match time, as
instant alerts show them). One tender appears once even if several held rows point at it.
Order: biddable tenders first, by deadline ascending (no deadline last), then the rest, by
deadline ascending. A tender whose status is `cancelled` is marked «չեղարկված», `closed` or
`awarded` «փակված», `amended` «փոփոխված» (an amended tender that is still biddable keeps its
place among the biddable ones). Each line: title, buyer, budget, deadline, the marker if any,
"Matched: …" with the search names, and the same tender link instant alerts use (the app link
when `APP.BASE_URL` is set, otherwise the procurement site). At most 20 lines, fewer if the
Telegram message limit would be exceeded, then "…and N more matches"; every held row in the
digest is marked `sent`, listed or counted. Telegram and email list the same tenders in the same
order. The email carries the per-destination unsubscribe link and both `List-Unsubscribe`
headers exactly as alert mail does. Wording is English, as every alert message is today.

**Formatters.** A digest renderer is added to the Telegram and email formatters; the ordering,
the markers, the cap and the line content live once in the shared presentation module both
formatters already use, so the two channels cannot drift.

**API.** `PATCH /integrations/telegram/:id` and `PATCH /integrations/email/:id` with body
`{ cadence: 'instant' | 'daily' }` (Joi, strip unknown). Permission `savedsearch:write`, like
the other integration writes, and scoped to the **caller's own** destination, as `enable` is:
another member's destination in the same organization is not found, and so is another
organization's. Answers the destination as the listing shows it. A switch to `instant` queues
the flush. `GET /integrations/telegram` and `GET /integrations/email` include `cadence` on every
row. No plan gate: the digest is part of `alerts`, which every plan includes.

**Matcher.** Unchanged in what it decides. Its job result counts held destinations separately
from delivered ones, so a log line does not report a held match as delivered.

**Documentation.** CLAUDE.md's "a live `channel_subscriptions` row IS the switch" bullet and the
2026-09-10 "no per-user preference layer" wording are amended to say cadence is a property of
the destination, not a preference store: there is still one row and one switch. The
`docs/API_REFERENCE.md` integrations section documents the PATCH and the new field.

## Testing Decisions

**No automated tests are written in this slice.** There is still no test runner (one
devDependency, no `tests/`, no `npm test`), as in the subscriptions slice.

A good test here asserts what a destination receives and what the delivery record says, never
which repository method ran.

When tests arrive, the seams are:

- **The worker handlers, against a real database, with the transports faked at the adapter.**
  Drive the matcher's handler and the `digest.send` handler; assert the `alert_deliveries` rows
  and the messages the fake Telegram client and mail port received. This one seam covers held
  vs. sent, the flush, the off-switch `skipped`, throttling, ordering, markers and the cap.
- **The HTTP boundary** for the cadence PATCH: own destination 200, a colleague's 404, another
  organization's 404, an invalid value 400, and `cadence` in the listings.
- **One narrow database check:** an `alert_deliveries` row naming a destination of another
  organization is refused by the composite key, and a `channel_subscriptions` insert with no
  cadence fails. A key that silently failed to be created would leave every handler test green.
- Prior art: the subscriptions and F-05 specs (same HTTP seam, same "the database arbitrates"
  exception), and `notifications_dedupe_uq` for a constraint checked directly.

**Verification by hand** against the local `tendra` database, recorded in each ticket:

- an organization with one instant Telegram chat and one daily email: a new match is `sent` to
  the chat and `held` for the email;
- an amendment and a reminder for the same organization reach the daily email immediately;
- running `digest.send` for the email sends one message, and its held rows become `sent`;
- running the morning job twice sends one digest;
- a held tender cancelled before the digest is listed last, marked «չեղարկված»;
- switching the email to instant flushes its held rows as one digest;
- revoking the email with held rows turns them `skipped`, and re-enabling it starts empty;
- an organization with only daily destinations no longer gets the "not switched on" row;
- a PATCH on a colleague's destination answers 404.

## Out of Scope

- A send time chosen per destination, weekdays-only, or any timezone column. One time for
  everyone; the timezone and quiet-hours columns stay deleted.
- A "nothing matched yesterday" message on an empty day.
- Cadence per saved search, or any per-user preference store.
- Holding amendments, reminders or any notification type other than `tender-match`.
- A relevance-ranked "tenders you might like" feed, or adding non-matched tenders to a digest.
- Weekly or other cadences.
- A link for "…and N more" — there is no frontend to link to yet; it is text until there is.
- Personal, per-user delivery of matches. Alerts stay organization-wide; a digest is
  per-destination only in when it is sent.
- A shared address (`alerts@company.am`) as a destination — still needs the token flow it
  needed before.

## Further Notes

- The grilling's Q6 was decided as "each destination remembers up to when it was last covered".
  The spec realises it with the held rows themselves rather than a stored timestamp, which gives
  the same behaviour for every scenario discussed (both cadence switches, a failed digest, a
  destination switched off and back on) with no second piece of state to keep consistent.
- An ADR was suggested for "cadence on the destination, not a preference layer" and not yet
  decided; the CLAUDE.md amendment above is required either way.
- Existing rows: databases are rebuilt from `create_table.js`, so every destination gets its
  channel's default cadence on rebuild. An existing email destination therefore turns daily.
