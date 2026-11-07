# 01 — Every delivery row names its destination

**What to build:** Today an `alert_deliveries` row says which notification and which channel it
belongs to, but not which destination — one chat or one address — it went to. After this ticket
every row the notifier writes for a real send names its destination, so "was this person told,
and how" is answerable from one row. This is the prefactor the digest needs (held rows are read
per destination), and it changes no delivery behaviour. See `.scratch/daily-digest/spec.md`,
*Implementation Decisions → Schema*.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] `alert_deliveries` carries `organization_id` (NOT NULL) and a nullable
      `channel_subscription_id`, both written straight into `create_table.js` / `drop_table.js`.
- [x] Both parents are reached only through composite foreign keys —
      `(notification_id, organization_id)` → `notifications (id, organization_id)` and
      `(channel_subscription_id, organization_id)` → `channel_subscriptions (id, organization_id)`
      — with no single-column FK beside them; both parents gain `UNIQUE (id, organization_id)`.
- [x] The destination key is `ON DELETE SET NULL (channel_subscription_id)`: deleting a
      destination keeps its delivery history (checked by deleting one on a scratch database).
- [x] Every row the notifier writes for a destination (sent, deferred, failed) names it; the
      "no live destination" `skipped` row, the misconfigured-channel row and the `log` channel's
      row name none.
- [x] The deferred sweep still works: a throttled delivery retried later writes rows naming the
      same destination.
- [x] A direct insert of a row whose destination belongs to another organization is refused by
      the database.
- [x] The stale quiet-hours comment on `deferred_until` is corrected.
- [x] A scratch database builds from `create_table.js` and drops cleanly with `drop_table.js`.
- [x] Verified by hand on the local `tendra` database: an instant alert to an organization with
      one Telegram chat and one email address writes two rows, each naming its destination.
