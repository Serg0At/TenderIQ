# 05 — The operator sees and voids an organization's subscriptions

**What to build:** The operator can answer "why is this company on Pro" and end a grant that was
a mistake or an abuse, for that one organization only. A voided period stops granting its plan,
but still counts as the organization's one trial or its one use of a code (spec § *API*
operator routes, stories 35–36).

**Blocked by:** 01 — A subscription is a dated period; 03 — The operator, and the promo-code
console.

**Status:** ready-for-agent

- [ ] `GET /operator/organizations/:id/subscriptions` lists every period of that organization,
      voided ones included, with kind, plan, dates, the code it came from and void details.
- [ ] `POST /operator/subscriptions/:id/void` records the void time and the operator. Repeating
      it is a success, not an error.
- [ ] After a void, the organization's next refresh carries the plan of whatever else covers
      now, or `free`.
- [ ] A voided trial still makes `trialAvailable` false, and the creator cannot start another.
      A voided promo still makes the same code `already_redeemed` for that organization.
- [ ] Both routes are behind the operator gate. An owner who is not an operator gets 403.
- [ ] `docs/API_REFERENCE.md` documents both routes.
