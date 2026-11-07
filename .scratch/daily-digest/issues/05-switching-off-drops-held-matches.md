# 05 — Switching a destination off drops its held matches

**What to build:** When a daily destination is switched off before its digest — by an owner or
admin through the API, by `/stop` in Telegram, by the unsubscribe link, or by auto-revocation
after repeated failures — its held matches are recorded as `skipped` with a reason instead of
waiting forever. Switching it back on starts empty: no backlog of everything since it went off.
See `.scratch/daily-digest/spec.md`, *The held rows are the cursor*.

**Blocked by:** 02 — A daily email receives its matches in one 08:00 digest.

**Status:** ready-for-agent

- [ ] Revoking a destination turns its `held` rows `skipped` with the detail
      "destination switched off before its digest", inside the repository's revoke, so every
      revoke path does it with no caller change.
- [ ] The tenant-scoped revoke, `/stop`, the unsubscribe POST and failure auto-revocation all
      leave no `held` row behind (each checked).
- [ ] Enabling a switched-off destination sends nothing from before; its next digest holds only
      matches after it came back on.
- [ ] The morning job finds no work for a revoked destination.
- [ ] Verified by hand: a daily email with held matches, revoked through the API, has those rows
      `skipped`; re-enabled and given one new match, its next digest lists only that match.
