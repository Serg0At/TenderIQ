# 02 — A daily email receives its matches in one 08:00 digest

**What to build:** The tracer bullet. A destination has a cadence — `instant` or `daily` — and a
new email destination is `daily`, a new Telegram chat `instant`. A new match is not sent to a
daily destination; it is held. At 08:00 Asia/Yerevan every day, each destination with held
matches receives one digest listing them, and the held rows become `sent`. A day with nothing
held sends nothing. Every other notification type still reaches a daily destination at once.
The list in this ticket may be plain (title, deadline, link, tenders as they are at send time);
ordering, markers and the cap are ticket 03. See `.scratch/daily-digest/spec.md`.

**Blocked by:** 01 — Every delivery row names its destination.

**Status:** done

- [x] `channel_subscriptions.cadence`, text NOT NULL, CHECK `instant | daily`, no database
      default; the repository sets `instant` for Telegram and `daily` for email when a
      destination is created, and an insert without a cadence fails.
- [x] `alert_deliveries.status` accepts `held`, with a partial index on the destination where
      `status = 'held'`.
- [x] A `tender-match` notification writes a `held` row, naming the destination, for each daily
      destination and sends it nothing; instant destinations of the same organization are sent
      to as before.
- [x] `amendment`, reminders, countdowns, vault expiry, team announcements, invitations and
      subscription notices reach a daily destination immediately.
- [x] The channel result gains `held` (none sent, none deferred, at least one held); an
      organization whose only email destinations are daily no longer gets the
      "email alerts are not switched on" `skipped` row. The matcher's job result counts held
      separately from delivered.
- [x] `digest.daily` and `digest.send` are constants in the queue-names file, on the ALERTS
      queue; the scheduler registers `digest.daily` at `0 8 * * *` in `Asia/Yerevan`.
- [x] `digest.daily` queues one `digest.send` per live destination that has held rows, with job
      id `digest-{destinationId}-{Yerevan date}`; running the morning job twice sends one digest.
- [x] `digest.send` sends one message through the channel's transport and the same outcome
      policy as an alert: sent → its rows `sent` with `sent_at`; throttled → rows stay `held` and
      the job is delayed by retry-after without spending an attempt; permanent / auth / invalid →
      rows `failed` with the detail, the failure counter and revocation as for an alert; the `log`
      driver outside development → `failed`.
- [x] A tender is read as it is at send time (latest version); one tender held twice appears
      once.
- [x] A destination revoked between the morning job and its `digest.send` receives nothing.
- [x] CLAUDE.md: the "a live `channel_subscriptions` row IS the switch" bullet and the
      2026-09-10 "no per-user preference layer" wording say that cadence is a property of the
      destination, not a preference store; the notifier's four-outcome bullet mentions `held`.
- [x] Verified by hand on the local `tendra` database: one instant Telegram chat and one daily
      email; a new match is `sent` to the chat and `held` for the email; an amendment reaches the
      email at once; running `digest.send` delivers one email and turns the rows `sent`.

## Verified (2026-11-08, local `tendra`)

A throwaway organization with one instant Telegram chat and two daily email destinations,
transports faked at the adapter, driven through `handleTenderMatched`, `deliver`,
`handleDigestDaily` and `handleDigestSend`; deleted afterwards.

- New chat `instant`, new email `daily`; an insert with no cadence fails on NOT NULL.
- Two new matches: each `sent` to the chat, `held` for each email naming it; no mail sent and no
  "not switched on" row. Matcher result `delivered: 2` (telegram + log), `held: 1`.
- Amendment, `reminder-24h`, `countdown-3h`, `vault-expiry-30d`, `team-invitation`,
  `subscription-ending`: each mailed to both daily emails at once.
- A second `tender-match` of the same tender: held, listed once (3 held rows → 2 tenders); the
  digest shows the tender's current deadline, not the stale payload's. The same notification met
  twice by `deliver` stays one held row (`alert_deliveries_held_uq`).
- `digest.daily` run twice: one `digest-{destination}-2026-11-08` job per daily destination.
- The second email revoked before its `digest.send`: `not_live`, nothing sent.
- Throttled (retry after 120 s): `DelayedError`, job delayed ~120 s, rows still `held`,
  failure counter 0. Then sent: one email, every held row `sent` with `sent_at`; a second
  `digest.send` that morning finds nothing.
- Permanent 550: rows `failed` with the detail, failure counter 1. `NODE_ENV=test` with the `log`
  driver: rows `failed` "channel misconfigured", counter untouched.
- A daily Telegram chat (cadence set by hand; the PATCH is ticket 04) receives its digest.

Left for later tickets, as the spec splits them: ordering, markers, buyer/budget/matched lines and
the 20-line cap (03 — a long plain digest to a daily Telegram chat could exceed 4096 characters
until then, and only ticket 04's PATCH makes a chat daily); held rows of a revoked destination
stay `held` until 05 turns them `skipped`.
