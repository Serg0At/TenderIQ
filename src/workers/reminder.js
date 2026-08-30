import notifications from '../repositories/notification.repo.js';
import trackedTenders from '../repositories/trackedTender.repo.js';
import { getChannel, channelsForOrg } from '../services/delivery.service.js';
import { logger } from '../utils/logger.js';

/**
 * Deadline reminders for tenders a supplier has already been alerted about.
 *
 * Only tenders they were matched on — reminding someone about a tender they
 * never expressed interest in is noise, and noise is what makes an alert
 * stream get muted.
 *
 * Two thresholds rather than a countdown: 72 hours is "there is still time to
 * assemble documents", 24 hours is "submit today". Each is its own
 * notification type, so the existing (org, type, tender) dedupe naturally
 * fires each one exactly once without a per-reminder state column.
 */
const THRESHOLDS = [
  { hours: 72, type: 'reminder-72h' },
  { hours: 24, type: 'reminder-24h' },
];

/**
 * The countdown: the same idea, tighter, for tenders the org has explicitly
 * decided to pursue.
 *
 * Deliberately ADDITIONAL to the matched reminders above rather than a
 * replacement for them. Moving the reminder wholesale onto `tracked_tenders`
 * looks like an upgrade and is a regression: it would silence every tender the
 * supplier has been alerted about but not yet triaged — which is precisely the
 * one most likely to be missed, and missed tenders are the #1 churn cause.
 *
 * So: matched tenders keep the 72h/24h safety net, and a pursuit earns a
 * closer clock on top of it. The two use different notification types, so the
 * existing (org, type, tender) dedupe fires each exactly once and a tender that
 * is both matched and tracked does not get the same warning twice.
 */
const COUNTDOWN = [
  { hours: 48, type: 'countdown-48h' },
  { hours: 12, type: 'countdown-12h' },
  { hours: 3, type: 'countdown-3h' },
];

export const handleDeadlineReminders = async () => {
  const now = Date.now();
  let created = 0;

  for (const { hours, type } of THRESHOLDS) {
    const until = new Date(now + hours * 60 * 60 * 1000);

    const due = await notifications.dueForReminder({ until, from: new Date(now) });

    for (const row of due) {
      const { created: isNew, notification } = await notifications.createIfNew({
        organizationId: row.organization_id,
        type,
        tenderId: row.tender_id,
        payload: {
          title: row.title,
          referenceCode: row.reference_code,
          deadlineAt: row.deadline_at,
          hoursRemaining: hours,
        },
      });

      if (!isNew) continue;
      created += 1;

      /**
       * Reminders are raised per (org, tender), not per saved search, so there
       * is no profile here to read a channel preference from — which is why
       * this used to hardcode the log channel and deadline reminders never
       * reached anyone. `channelsForOrg` resolves what the org can actually be
       * reached on, adding Telegram only when a chat is linked so an org
       * without one does not accrue a failed row on every sweep.
       *
       * Each channel records its own delivery row — see the contract note in
       * services/delivery.service.js.
       */
      for (const channelName of await channelsForOrg(row.organization_id)) {
        await getChannel(channelName).send(notification);
      }
    }
  }

  if (created) logger.info(`[reminder] ${created} deadline reminder(s) raised`);
  return { created };
};

/**
 * The pipeline countdown.
 *
 * Fires only on `considering` and `preparing` — a pursuit already submitted has
 * nothing left to do before the deadline, and one that was dropped is a
 * decision the supplier already made. Reminding them about either is the noise
 * that gets an alert stream muted.
 */
export const handleTrackedCountdown = async () => {
  const now = Date.now();
  let created = 0;

  for (const { hours, type } of COUNTDOWN) {
    const until = new Date(now + hours * 60 * 60 * 1000);
    const due = await trackedTenders.dueForCountdown({ until, from: new Date(now) });

    for (const row of due) {
      const { created: isNew, notification } = await notifications.createIfNew({
        organizationId: row.organization_id,
        type,
        tenderId: row.tender_id,
        payload: {
          title: row.title,
          referenceCode: row.reference_code,
          deadlineAt: row.deadline_at,
          hoursRemaining: hours,
          trackedTenderId: row.tracked_tender_id,
          pipelineStatus: row.status,
        },
      });

      if (!isNew) continue;
      created += 1;

      for (const channelName of await channelsForOrg(row.organization_id)) {
        await getChannel(channelName).send(notification);
      }
    }
  }

  if (created) logger.info(`[reminder] ${created} pipeline countdown(s) raised`);
  return { created };
};

/**
 * One job runs both sweeps. They read different tables and raise different
 * notification types, but they answer the same question — "what is about to
 * close?" — and splitting them into two schedules would only create a window
 * where one had run and the other had not.
 */
export const processReminder = async () => {
  const reminders = await handleDeadlineReminders();
  const countdowns = await handleTrackedCountdown();
  return { reminders: reminders.created, countdowns: countdowns.created };
};

export default { handleDeadlineReminders, handleTrackedCountdown, processReminder };
