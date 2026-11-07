# 02 — A daily email receives its matches in one 08:00 digest

**What to build:** The tracer bullet. A destination has a cadence — `instant` or `daily` — and a
new email destination is `daily`, a new Telegram chat `instant`. A new match is not sent to a
daily destination; it is held. At 08:00 Asia/Yerevan every day, each destination with held
matches receives one digest listing them, and the held rows become `sent`. A day with nothing
held sends nothing. Every other notification type still reaches a daily destination at once.
The list in this ticket may be plain (title, deadline, link, tenders as they are at send time);
ordering, markers and the cap are ticket 03. See `.scratch/daily-digest/spec.md`.

**Blocked by:** 01 — Every delivery row names its destination.

**Status:** ready-for-agent

- [ ] `channel_subscriptions.cadence`, text NOT NULL, CHECK `instant | daily`, no database
      default; the repository sets `instant` for Telegram and `daily` for email when a
      destination is created, and an insert without a cadence fails.
- [ ] `alert_deliveries.status` accepts `held`, with a partial index on the destination where
      `status = 'held'`.
- [ ] A `tender-match` notification writes a `held` row, naming the destination, for each daily
      destination and sends it nothing; instant destinations of the same organization are sent
      to as before.
- [ ] `amendment`, reminders, countdowns, vault expiry, team announcements, invitations and
      subscription notices reach a daily destination immediately.
- [ ] The channel result gains `held` (none sent, none deferred, at least one held); an
      organization whose only email destinations are daily no longer gets the
      "email alerts are not switched on" `skipped` row. The matcher's job result counts held
      separately from delivered.
- [ ] `digest.daily` and `digest.send` are constants in the queue-names file, on the ALERTS
      queue; the scheduler registers `digest.daily` at `0 8 * * *` in `Asia/Yerevan`.
- [ ] `digest.daily` queues one `digest.send` per live destination that has held rows, with job
      id `digest-{destinationId}-{Yerevan date}`; running the morning job twice sends one digest.
- [ ] `digest.send` sends one message through the channel's transport and the same outcome
      policy as an alert: sent → its rows `sent` with `sent_at`; throttled → rows stay `held` and
      the job is delayed by retry-after without spending an attempt; permanent / auth / invalid →
      rows `failed` with the detail, the failure counter and revocation as for an alert; the `log`
      driver outside development → `failed`.
- [ ] A tender is read as it is at send time (latest version); one tender held twice appears
      once.
- [ ] A destination revoked between the morning job and its `digest.send` receives nothing.
- [ ] CLAUDE.md: the "a live `channel_subscriptions` row IS the switch" bullet and the
      2026-09-10 "no per-user preference layer" wording say that cadence is a property of the
      destination, not a preference store; the notifier's four-outcome bullet mentions `held`.
- [ ] Verified by hand on the local `tendra` database: one instant Telegram chat and one daily
      email; a new match is `sent` to the chat and `held` for the email; an amendment reaches the
      email at once; running `digest.send` delivers one email and turns the rows `sent`.
