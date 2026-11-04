# 01 — A subscription is a dated period, and the plan is read from the clock

**What to build:** An organization's plan comes from the subscription covering this moment. A
period that has lapsed stops granting its plan on its own, with no job flipping anything. Every
member can see which plan the organization is on and until when. Nothing writes subscriptions
through the API yet; this is the foundation the trial and promo codes stand on (ADR 0005, spec
§ *Schema* and § *Reading the plan*).

**Blocked by:** None — can start immediately.

**Status:** done

- [x] `subscriptions` holds one row per period: organization, plan, `kind` (`trial` | `promo` |
      `paid`, CHECK), period start and end, nullable promo code and trial-creator references, and
      void time and voider. The one-row-per-organization uniqueness, `status` and `renews_at` are
      gone.
- [x] An exclusion constraint refuses two non-voided subscriptions of one organization whose
      half-open periods overlap. A period starting at the exact moment another ends is accepted.
- [x] Inserting two overlapping non-voided rows directly fails with an exclusion violation, and
      the same pair with one voided succeeds.
- [x] The plan lookup answers with the plan of the non-voided subscription covering now, else
      `free`. It never reads a status.
- [x] With a `pro` row covering now inserted by SQL, a new session carries `pro` and an
      intelligence route answers 200. After the row's dates are moved into the past, the next
      refresh carries `free` and the same route answers 402.
- [x] `GET /organization/subscription` answers `{ current, next, trialAvailable }` to every
      member (`tender:read`). `current` and `next` are each `{ id, kind, plan, periodStart,
      periodEnd }` or null, and `trialAvailable` is true exactly when the organization has never
      had a subscription and its creator has no trial row.
- [x] Applied to live databases through one idempotent additive script, mirrored into the
      full-schema migration and its drop, then the script is deleted. The table has never had a
      writer, so no data moves.
- [x] CLAUDE.md no longer names bank transfer as the payment backbone, no longer says the ՀՎՀՀ
      is collected when paying by invoice, and no longer says no subscription writer exists.
      `docs/API_REFERENCE.md` documents the new endpoint.

## Done (2026-11-01)

`migrations/add_subscription_periods.js` ran twice on local `tendra` and was then deleted; Neon
is rebuilt from the full schema (`migrate:down` + `migrate:up`) rather than through it.
`create_table.js` and `drop_table.js` carry the same shape (a fresh database's `subscriptions`
constraints, indexes and columns diff clean against local, and the drop also removes
`btree_gist`).

- **Schema.** `kind` CHECK; `period_end > period_start` CHECK, because an empty range overlaps
  nothing and would slip past the exclusion; `subscriptions_no_overlap_excl` over
  `(organization_id WITH =, tstzrange(period_start, period_end) WITH &&) WHERE voided_at IS NULL`;
  `subscriptions_org_start_idx`. `promo_code_id` references `promo_codes` (RESTRICT): ticket 03
  landed first, so the reshape carries the foreign key. The one-trial-per-creator index is ticket 02's.
- **Reading.** `subscription.repo.js#current` is the one "covering now" (half-open `@> now()`, the
  database clock); `organization.repo.js#planFor` calls it. `next` is the earliest non-voided
  period starting after now. `trialAvailable` = no row ever (voided included) and no trial row
  with the organization's `created_by` as `trial_creator_id`, in any organization.
- **Route.** `features/subscriptions/`, mounted at `/organization/subscription`, `tender:read`.

**Verified by hand** (API on :5055, local `tendra`, a throwaway user and organization, removed
afterwards):

| step | result |
|---|---|
| new organization | session `free`; view `{ current: null, next: null, trialAvailable: true }`; `/benchmarks/30000000` 402 |
| SQL-insert `promo` on `pro`, now − 1 d → now + 30 d | refresh → `pro`; fresh login + switch-org → `pro`; benchmark 200; view shows it as `current`, `trialAvailable: false` |
| move it to now − 40 d → now − 10 d | old token still 200 (stateless, ≤ 15 min); refresh → `free`; benchmark 402; view `current: null` |
| current trial + `next` promo starting at its end + a voided `business` row overlapping both | session `pro` (voided row ignored); view shows the trial as `current`, the promo as `next` |
| second organization of the same creator, never subscribed | `trialAvailable: false` (its creator has a trial elsewhere) |

Direct inserts, in a rolled-back transaction: two overlapping non-voided rows →
`conflicting key value violates exclusion constraint "subscriptions_no_overlap_excl"`; the same
pair with one voided → accepted; a period starting at the exact instant another ends → accepted;
a zero-length period → `subscriptions_period_chk`; `kind = 'gift'` → `subscriptions_kind_chk`.
