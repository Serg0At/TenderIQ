# 06 — Ending announcements

**What to build:** Every member hears that the organization's period is about to end and that it
has ended, so the 402s that follow are never a surprise. Nobody is warned about an end that is
not one, because another period starts at that moment (spec § *Ending announcements*, stories
21–23).

**Blocked by:** 01 — A subscription is a dated period.

**Status:** done

- [x] A daily sweep runs on the alerts queue, registered by the scheduler like the vault expiry
      sweep, with its queue and job names as constants.
- [x] A non-voided period ending within 3 days raises a `subscription-ending` announcement. A
      period that has ended raises `subscription-ended`. Both go through the team announcement
      path, organization-wide.
- [x] Neither is raised when a non-voided period of the same organization starts at that
      period's end.
- [x] The dedupe subjects are one per period per event, so repeated sweeps announce each period
      once each way.
- [x] The wording is third person and names the plan, the kind and the date, never a person.
- [x] By hand: periods inserted by SQL with an end two days away, an end yesterday, and an end
      followed by another period produce exactly two announcements across two sweep runs.

## Done

No schema change. The types are new strings in `notifications.type`, which has no CHECK, and the
dedupe subjects ride `notifications_dedupe_uq` as the vault alerts' do.

- **Queue and schedule.** `JOB.SUBSCRIPTION_ENDING` (`subscription.ending`) on ALERTS, dispatched
  by `workers/matcher.js#processMatch` beside `vault.expiry`. The scheduler registers
  `subscription-ending` daily at `17 6 * * *`, six minutes after the vault sweep, so the two do
  not land on one tick.
- **Repository.** `subscription.repo.js#endingOrEnded` is the one read, across every
  organization (the class comment lists it with the operator exceptions). It returns non-voided
  periods whose end is within 3 days ahead or 3 days back, joined to the plan and organization
  name, with `ended` computed as `period_end <= now()`. A follower is ruled out in SQL with
  `NOT EXISTS`: a non-voided period of the same organization whose `period_start = period_end`,
  compared in Postgres so microseconds are kept. Both windows read the database clock, the one
  `current` reads.
- **Worker.** `workers/subscriptionEnding.js` raises each row through `AnnouncementService.raise`,
  as `subscription-ending` or `subscription-ended`, with subject `{id}-ending` or `{id}-ended`.
  The payload is `subscriptionId`, `organizationName`, `plan`, `periodKind` and `periodEnd`. It
  is `periodKind`, not `kind`, because the email subject reads `kind` as the thing an alert is
  about.
- **Wording.** `notification.present.js` has headings for both types, plus `isSubscriptionType`
  and `subscriptionAnnouncement`. Telegram and email render the sentence the way they render a
  team announcement, with an "Open subscription" link once `APP_BASE_URL` is set. The end is
  given in Yerevan time, date and time of day. Example: "ZZ Test Ending LLC's Pro trial ends on
  3 November 2026 at 12:23 Yerevan time. Unless another period follows it, the organization
  returns to the Free plan then." What follows the end is stated as a condition, because the
  message outlives the sweep that wrote it.
- **Decided while building:** an end is announced as `ended` for up to 3 days after it, which
  rides out two missed daily runs. A first run therefore announces no end older than 3 days. A
  period first seen after it ended gets only the `ended` announcement.
- `docs/API_REFERENCE.md` lists both types and their dedupe subjects in the notification-type
  table.

**Verified by hand** (local `tendra`, throwaway organizations and periods with ids `zztest-*`,
removed afterwards along with their notifications, deliveries and finished jobs). The job went
through the real path: `subscription.ending` added to ALERTS, a temporary alerts-only worker
running `processMatch`, then `notify.deliver`. The full worker was not started, so live
ingestion was not resumed. `npm run scheduler` logged `subscription ending sweep scheduled
"17 6 * * *"`.

| period | run 1 | run 2 |
|---|---|---|
| org A: trial ending in 2 days | `subscription-ending`, subject `…-ending`, delivered | nothing |
| org A: voided promo ending in 1 day | nothing | nothing |
| org B: promo ended yesterday | `subscription-ended`, subject `…-ended`, delivered | nothing |
| org C: trial ending in 2 days, promo starting at its end (copied in SQL, microseconds kept) | nothing | nothing |
| **sweep result** | `{ ending: 1, ended: 1 }` | `{ ending: 0, ended: 0 }` |

That is exactly two announcements across two runs. In a third and fourth run, org A's trial end
was moved to an hour ago. The third run raised `subscription-ended` (`…-ended`) for it, and the
fourth raised nothing, so a period is announced once each way.
