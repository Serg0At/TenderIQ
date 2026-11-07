# 06 — One digest per destination at a time

**What to build:** Two digest sends for the same destination can run at once and both deliver
the same held matches, because `sendDigest` reads the held rows, sends, and only then settles
them. The ALERTS worker runs at concurrency 4 and more than one worker process may run, and the
two sends have different job ids, so BullMQ does not stop it. Ways it happens: a switch to
instant shortly before 08:00 (the flush and the morning job), a throttled morning digest whose
delayed retry overlaps a flush, or two worker processes. Found while building ticket 04. After
this ticket a destination is sent at most one digest at a time. A second send waits until the
first has finished, then finds nothing held, or only rows that arrived since. See
`.scratch/daily-digest/spec.md`, *Digest job*.

**Blocked by:** 02 — A daily email receives its matches in one 08:00 digest.

**Status:** done

**Shape (decided):** a per-destination lock in Redis, the same pattern as the listing chain's
`{watermark key}:chain` marker (ticket 38): `SET NX` with a TTL and a random holder token, held
around read → send → settle, and released in `finally` only by its holder. A send that finds the
lock taken does not skip, because the holder may be about to defer on a throttle. It delays its
own job briefly without spending an attempt. Set the TTL well above a send's worst case (an
SMTP timeout), so a crashed holder's lock expires and the rows, still `held`, go out on the
next attempt. No schema change. A row-claim column was considered and rejected: a crash after
the claim would strand rows unless a second expiry rule existed.

- [x] Two `digest.send` jobs for one destination that start together deliver one message; the
      second finds the lock, delays itself, and on its next run sends nothing (all rows `sent`)
      or only rows held since.
- [x] A throttled digest still leaves its rows `held` and releases the lock, so its delayed
      retry, or a flush, can take it.
- [x] A lock is released only by the holder whose token it carries: a holder whose lock expired
      cannot delete a newer holder's lock.
- [x] A holder that dies without releasing it blocks the destination for at most the TTL. Its
      rows are still `held` and go out on the next attempt.
- [x] The lock key's name is defined once, beside the other Redis key helpers, not as a literal
      in two places.
- [x] Verified by hand: queue the morning job and a flush for one daily destination at the same
      moment (or run two `sendDigest` calls in parallel from a script) and receive one digest;
      the `alert_deliveries` rows are each `sent` once.

**Verified 2026-11-08** against the local `tendra` database and Redis, with a throwaway
organization and one daily email destination, the mail port wrapped to count sends (and to
answer a throttle) — 18 checks, all passing. Two `sendDigest` calls started together for two
held matches: one `sent`, one `locked`; **one** message went out, both rows `sent` once, the lock
was gone afterwards, and the locked call's next run answered `empty`. Through `handleDigestSend`,
a taken lock moved the job to delayed (30 s) with `DelayedError` — no attempt spent — and left
the other holder's lock in place; its next run sent only the one row held since. A throttled
digest answered `deferred`, left its row `held` and released the lock, and the next send took it
and delivered the row. A holder whose lock expired could not delete the newer holder's lock. A
lock left by a dead holder answered `locked` with the rows untouched until its TTL ran out, and
then all four held rows went out in one digest.

The lock is `digest:lock:{destinationId}` (`utils/sweepState.js#digestLockKey`, beside
`chainKey`), with a TTL of 10 minutes (SMTP's worst case is 10 + 10 + 20 s, Telegram's 15 s), and
a locked send retries after 30 s.
