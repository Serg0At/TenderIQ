# 05 — Switching a destination off drops its held matches

**What to build:** When a daily destination is switched off before its digest — by an owner or
admin through the API, by `/stop` in Telegram, by the unsubscribe link, or by auto-revocation
after repeated failures — its held matches are recorded as `skipped` with a reason instead of
waiting forever. Switching it back on starts empty: no backlog of everything since it went off.
See `.scratch/daily-digest/spec.md`, *The held rows are the cursor*.

**Blocked by:** 02 — A daily email receives its matches in one 08:00 digest.

**Status:** done

- [x] Revoking a destination turns its `held` rows `skipped` with the detail
      "destination switched off before its digest", inside the repository's revoke, so every
      revoke path does it with no caller change.
- [x] The tenant-scoped revoke, `/stop`, the unsubscribe POST and failure auto-revocation all
      leave no `held` row behind (each checked).
- [x] Enabling a switched-off destination sends nothing from before; its next digest holds only
      matches after it came back on.
- [x] The morning job finds no work for a revoked destination.
- [x] Verified by hand: a daily email with held matches, revoked through the API, has those rows
      `skipped`; re-enabled and given one new match, its next digest lists only that match.

## Notes from building

- The drop lives in `channelSubscription.repo.js#revokeWhere`, which both `revoke` and
  `revokeForOrg` call, in one transaction with the revoke: only a row that call actually
  revoked drops anything. Callers checked: `emailAlerts.unsubscribe` and `telegramLink.unlink`
  (`revokeForOrg`); `/stop`, the blocked-bot update, `unsubscribe.service.js#revoke`, the
  notifier's permanent-failure revoke and `recordFailure`'s auto-revocation (`revoke`). None
  changed.
- **A digest's own settlement overrides the drop.** The digest's send can itself revoke (a
  blocked bot, the failure that reaches the ceiling), and a switch-off can land between its
  read and its settle. Those rows were attempted, so `settleHeld` also moves a row skipped
  with `SWITCHED_OFF_BEFORE_DIGEST`, and they record `failed` (or `sent`) rather than
  "switched off before its digest".
- **Coming back on drops a match held while off** — `reactivate` and the revived row of
  `createVerified` drop held rows before the row goes live. A delivery that listed the
  destination just before the revoke can still write a held row after it; without this, that
  row would be in the first digest after re-enabling.
- Verified on the local database with a scratch organization (removed afterwards), through
  the services the controllers call: API revoke, cross-tenant revoke refused, unsubscribe POST
  (and its idempotent repeat), auto-revocation, a failing digest that revokes, `/stop`, the
  blocked-bot update and the Telegram API unlink each left no `held` row; after re-enabling,
  one new match produced a digest of exactly that one tender, the two dropped rows staying
  `skipped`; the morning job's query did not return the revoked destination.
