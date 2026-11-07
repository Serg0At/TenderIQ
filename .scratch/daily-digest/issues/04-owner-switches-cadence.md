# 04 — A destination's owner switches its cadence

**What to build:** A member can switch their own Telegram chat or email address between instant
and daily, and everyone in the organization can see each destination's cadence in the
integrations listing. Nobody can change a colleague's cadence. Switching from daily to instant
sends whatever was held at once as one digest, so the switch never loses a match; switching from
instant to daily repeats nothing already sent. See `.scratch/daily-digest/spec.md`, *API* and
*The held rows are the cursor*.

**Blocked by:** 02 — A daily email receives its matches in one 08:00 digest.

**Status:** ready-for-agent

- [ ] `PATCH /api/v1/integrations/telegram/:id` and `PATCH /api/v1/integrations/email/:id` take
      `{ cadence: 'instant' | 'daily' }` (Joi, strip unknown; anything else `VALIDATION_FAILED`),
      gated on `savedsearch:write`, and answer the destination in the `{ data }` envelope as the
      listing shows it.
- [ ] Scoped to the caller's own destination, as `enable` is: a colleague's destination in the
      same organization and another organization's both answer `NOT_FOUND`.
- [ ] `GET /integrations/telegram` and `GET /integrations/email` include `cadence` on every row.
- [ ] Daily → instant with held rows queues a flush `digest.send` for that destination (its own
      job id, hyphens only), which delivers them as one digest; with none held, nothing is sent.
- [ ] Instant → daily holds only matches that arrive after the switch.
- [ ] No plan gate: a free organization can switch.
- [ ] `docs/API_REFERENCE.md` documents the PATCH and the `cadence` field.
- [ ] Verified by hand: a PATCH on one's own email to instant flushes its held matches as one
      email; a PATCH on a colleague's destination answers 404.
