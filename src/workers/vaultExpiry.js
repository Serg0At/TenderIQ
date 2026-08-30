import vaultDocuments from '../repositories/vaultDocument.repo.js';
import notifications from '../repositories/notification.repo.js';
import { getChannel, channelsForOrg } from '../services/delivery.service.js';
import config from '../configs/variables.config.js';
import { logger } from '../utils/logger.js';

const { VAULT } = config;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Vault expiry alerts.
 *
 * The second thing the vault is for. Storing certificates is filing; telling a
 * supplier their tax clearance lapses in a week is the part that stops a bid
 * being disqualified on a technicality — which is the failure this feature
 * exists to prevent, and one nobody notices until the day it happens.
 *
 * Deliberately a separate worker from `reminder.js` rather than a third sweep
 * inside it. That file bundles two sweeps because they answer the same question
 * on the same clock — "what is about to close?", hourly. This answers a
 * different question on a different one: expiry moves in days, so a daily run
 * is the honest cadence and an hourly one would re-scan the same rows 23 times
 * for nothing.
 */

/**
 * One notification type per threshold, exactly as the deadline reminders do.
 *
 * That is what makes the existing dedupe fire each warning once without a
 * per-document state column: a certificate 30 days out is warned about at 30, at
 * 7 and at 1, and never twice at the same threshold.
 */
const typeFor = (days) => `vault-expiry-${days}d`;

const notifyOrg = async (notification) => {
  for (const channelName of await channelsForOrg(notification.organization_id)) {
    await getChannel(channelName).send(notification);
  }
};

/**
 * Warn about documents crossing a threshold.
 *
 * Windows are half-open — `(previous, current]` — so consecutive thresholds
 * cannot both claim the same document on one run. Without that, a certificate
 * 7 days out would match the 30-day query and the 7-day query on the same day
 * and earn two alerts saying different things.
 */
export const handleExpiryWarnings = async ({ now = new Date() } = {}) => {
  let created = 0;

  // Descending, guaranteed by the config parser — the narrower window is
  // subtracted from the wider one, so the order is load-bearing.
  const thresholds = VAULT.EXPIRY_WARN_DAYS;

  for (let i = 0; i < thresholds.length; i += 1) {
    const days = thresholds[i];
    const next = thresholds[i + 1] ?? 0;

    const due = await vaultDocuments.dueForExpiryWarning({
      from: new Date(now.getTime() + next * DAY_MS),
      until: new Date(now.getTime() + days * DAY_MS),
    });

    for (const row of due) {
      const { created: isNew, notification } = await notifications.createIfNew({
        organizationId: row.organization_id,
        type: typeFor(days),
        // No tender: a certificate belongs to the organisation, not to a
        // procurement. `subjectId` is what keeps this from deduping against
        // every other expiring document in the same org.
        subjectId: row.id,
        payload: {
          documentId: row.id,
          kind: row.kind,
          filename: row.filename,
          validUntil: row.valid_until,
          daysRemaining: days,
        },
      });

      if (!isNew) continue;
      created += 1;
      await notifyOrg(notification);
    }
  }

  if (created) logger.info(`[vault] ${created} expiry warning(s) raised`);
  return { created };
};

/**
 * The one that has already lapsed.
 *
 * Separate from the countdown because it is a different message: the countdown
 * says "renew this", and this says "you cannot bid with this any more". Fires
 * once per document — `subjectId` plus a single type — so a certificate nobody
 * renews does not produce a daily alert until it is deleted.
 */
export const handleExpired = async ({ now = new Date() } = {}) => {
  let created = 0;

  for (const row of await vaultDocuments.expired({ asOf: now })) {
    const { created: isNew, notification } = await notifications.createIfNew({
      organizationId: row.organization_id,
      type: 'vault-expired',
      subjectId: row.id,
      payload: {
        documentId: row.id,
        kind: row.kind,
        filename: row.filename,
        validUntil: row.valid_until,
        daysRemaining: 0,
      },
    });

    if (!isNew) continue;
    created += 1;
    await notifyOrg(notification);
  }

  if (created) logger.info(`[vault] ${created} expired-document alert(s) raised`);
  return { created };
};

/**
 * Housekeeping: registered uploads whose bytes never arrived.
 *
 * Not cosmetic. A pending row holds the (organization_id, hash) slot, so an
 * abandoned upload blocks a later genuine one of the same document with a
 * conflict the customer has no way to explain or clear.
 */
export const prunePendingUploads = async ({ now = new Date() } = {}) => {
  const deleted = await vaultDocuments.prunePending({
    olderThan: new Date(now.getTime() - VAULT.PENDING_TTL_HOURS * 60 * 60 * 1000),
  });
  if (deleted) logger.info(`[vault] pruned ${deleted} abandoned upload(s)`);
  return { deleted };
};

/**
 * One job runs all three. They read the same table on the same clock, and
 * splitting them would only create a window where one had run and the others
 * had not.
 */
export const processVaultExpiry = async () => {
  const now = new Date();
  const warnings = await handleExpiryWarnings({ now });
  const expired = await handleExpired({ now });
  const pruned = await prunePendingUploads({ now });
  return { warnings: warnings.created, expired: expired.created, pruned: pruned.deleted };
};

export default { handleExpiryWarnings, handleExpired, prunePendingUploads, processVaultExpiry };
