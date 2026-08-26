import notifications from '../repositories/notification.repo.js';
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

export const processReminder = async () => handleDeadlineReminders();

export default { handleDeadlineReminders, processReminder };
