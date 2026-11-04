import subscriptions from '../repositories/subscription.repo.js';
import AnnouncementService from '../services/announcement.service.js';
import { logger } from '../utils/logger.js';

/**
 * Ending announcements (spec § Ending announcements).
 *
 * A lapsed period stops granting its plan by the clock alone, with nothing to
 * flip it, so nothing would otherwise tell an organization its Pro features are
 * about to go — the first sign would be a 402. Every member hears it twice:
 * three days ahead, and once it has ended.
 */

/** How far ahead an end is announced. */
const ENDING_NOTICE_DAYS = 3;

/**
 * How far back an end still earns its `ended` announcement. The sweep is
 * daily, so one day would do; three ride out two missed runs. A first run
 * announces no older end than this, and dedupe keeps a later one from
 * announcing it again.
 */
const ENDED_LOOKBACK_DAYS = 3;

/**
 * One job raises both. A period inside the window is either still ending or
 * already ended — the row says which — and its subject is one per period per
 * event, so a period is announced once each way however often this runs. A
 * period found only after it ended gets the `ended` announcement alone.
 */
export const processSubscriptionEnding = async () => {
  const due = await subscriptions.endingOrEnded({
    aheadDays: ENDING_NOTICE_DAYS,
    backDays: ENDED_LOOKBACK_DAYS,
  });

  let ending = 0;
  let ended = 0;
  for (const row of due) {
    const event = row.ended ? 'ended' : 'ending';
    const { raised } = await AnnouncementService.raise({
      organizationId: row.organization_id,
      type: `subscription-${event}`,
      subjectId: `${row.id}-${event}`,
      payload: {
        subscriptionId: row.id,
        organizationName: row.organization_name,
        plan: row.plan,
        // Not `kind`: the email subject reads that key as the thing the alert
        // is about, and "trial" names nothing.
        periodKind: row.kind,
        periodEnd: row.period_end,
      },
    });
    if (!raised) continue;
    if (row.ended) ended += 1;
    else ending += 1;
  }

  if (ending || ended) logger.info(`[subscriptions] ${ending} ending and ${ended} ended announcement(s) raised`);
  return { ending, ended };
};

export default { processSubscriptionEnding };
