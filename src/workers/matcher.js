import { UnrecoverableError } from 'bullmq';
import { JOB } from '../queues/names.js';
import savedSearches from '../repositories/savedSearch.repo.js';
import notifications from '../repositories/notification.repo.js';
import tenders from '../repositories/tender.repo.js';
import { getChannel, channelsForOrg } from '../services/delivery.service.js';
import { matchesByOrganization, channelsForMatches, matchCandidate, ALERTABLE_STATUSES } from '../services/matcher.service.js';
import { logger } from '../utils/logger.js';

/**
 * Fan a newly ingested or amended tender out to the saved searches it matches.
 *
 * Runs as a job rather than inline in the normalizer for two reasons: matching
 * against every profile is unbounded work that must not slow ingestion, and a
 * bug here must not roll back a tender that was correctly parsed.
 *
 * Amendments re-notify with a change summary — a moved deadline is exactly the
 * kind of thing a supplier needs to hear twice — but only for what actually
 * moved, which is why `changedFields` (and, for an addendum, `documentChanges`
 * from services/addendum.service.js) ride along on the event.
 */
export const handleTenderMatched = async (job) => {
  const { tenderId, event = 'TenderIngested', changedFields = [], documentChanges = null } = job.data;
  if (!tenderId) throw new UnrecoverableError('match.tender requires tenderId');

  const tender = await tenders.findDetail(tenderId);
  if (!tender) return { skipped: 'unknown_tender' };

  if (!ALERTABLE_STATUSES.includes(tender.status)) {
    return { skipped: `status_${tender.status}` };
  }

  const candidate = matchCandidate(tender);
  const profiles = await savedSearches.listAll();
  const type = event === 'TenderAmended' ? 'amendment' : 'tender-match';
  /**
   * One amendment is one version, so the version is its dedupe key
   * (`notifications_dedupe_uq` on org, type, tender, subject). With a NULL
   * subject, as before ticket 18, the first amendment of a tender was the
   * only one any organization was ever told about: the second deadline move
   * or addendum hit the first one's row. A retried job carries the same
   * version and stays deduped. A job queued before `version` rode along
   * falls back to the tender's current one.
   */
  const subjectId = type === 'amendment' ? `v${job.data.version ?? tender.version}` : null;
  const groups = matchesByOrganization(candidate, profiles);

  // `matched` counts searches and `notified` counts organizations alerted, so a
  // log line cannot read five matching searches in one org as five alerts sent.
  let matched = 0;
  let notified = 0;
  let delivered = 0;
  // Throttled by a provider, not lost — counted separately so a run that
  // delivered nothing because a provider pushed back is not read as a broken
  // channel.
  let deferred = 0;

  for (const { organizationId, matches } of groups) {
    matched += matches.length;
    const [best] = matches;

    const { created, notification } = await notifications.createIfNew({
      organizationId,
      type,
      tenderId,
      subjectId,
      payload: {
        title: tender.title,
        referenceCode: tender.reference_code,
        deadlineAt: tender.deadline_at,
        estimatedValue: tender.estimated_value,
        currency: tender.currency,
        // Carried on the payload so a delivery channel can render a complete
        // message without a second database read. A channel that has to join
        // back to `tenders` to say who the buyer is would couple transport to
        // the schema, and the payload is already the notification's contract.
        buyerName: tender.buyer_name ?? null,
        sourceUrl: tender.invitation_url ?? null,
        // The best match's, kept at the top level so a reader written before
        // `matchedSearches` existed still finds them.
        score: best.score,
        reasons: best.reasons,
        // Every search that matched, as named when the alert was raised: the
        // payload is the notification's record, so a later rename does not
        // rewrite what a past alert said.
        matchedSearches: matches.map(({ id, name, score, reasons }) => ({ id, name, score, reasons })),
        // The "what changed" summary the spec asks for on re-notification.
        ...(type === 'amendment' ? { changedFields, ...(documentChanges ? { documentChanges } : {}) } : {}),
      },
    });

    // Already told them: dedupe is per (org, type, tender, subject), so a
    // re-run of the matcher is silent rather than a second ping.
    if (!created) continue;
    notified += 1;

    /**
     * A search that names no channel is asking to be reached however this org
     * can be reached — so resolve it now rather than falling back to `log`,
     * which is an operator record and not a delivery. Reminders and vault
     * expiry already route through `channelsForOrg` for the same reason.
     *
     * Each channel sends once however many searches named it: a channel fans
     * out to every destination itself, so a second call would be a second copy.
     */
    const { named, useOrgDefault } = channelsForMatches(matches);
    const channels = useOrgDefault
      ? [...new Set([...named, ...(await channelsForOrg(organizationId))])]
      : named;
    for (const channelName of channels) {
      const channel = getChannel(channelName);
      // The channel writes its own alert_deliveries rows — one per destination
      // it actually attempted. Recording an aggregate here as well produced a
      // duplicate row for every alert and reported a deferred message as a
      // failure. See the contract note in services/delivery.service.js.
      const status = await channel.send(notification);
      if (status === 'sent') delivered += 1;
      if (status === 'deferred') deferred += 1;
    }
  }

  if (matched) {
    logger.info(
      `[matcher] ${tender.reference_code}: ${matched} match(es) across ${groups.length} org(s), ` +
        `${notified} notified, ${delivered} delivered` +
        (deferred ? `, ${deferred} deferred` : '')
    );
  }

  return { tenderId, event, profiles: profiles.length, matched, notified, delivered, deferred };
};

/**
 * Both alert producers share this queue and therefore one concurrency budget —
 * a reminder sweep cannot starve a freshly ingested tender's match, which is
 * the one with a 5-minute delivery target.
 */
export const processMatch = async (job) => {
  switch (job.name) {
    // processReminder, not handleDeadlineReminders: it runs BOTH the matched
    // safety net and the tighter pipeline countdown. Calling the inner function
    // directly is how the countdown would silently never fire.
    case JOB.DEADLINE_REMINDER:
      return (await import('./reminder.js')).processReminder();
    case JOB.DELIVER_DEFERRED:
      return (await import('./notifier.js')).handleDeferredDeliveries();
    /**
     * Rides this queue rather than MAINTENANCE because what it produces is a
     * customer-visible result — "you won" — not housekeeping, and it must not
     * queue behind a nightly profile rebuild on the day someone is waiting to
     * find out.
     */
    case JOB.RECONCILE_BIDS:
      return (await import('../services/bidOutcome.service.js')).default.reconcile();
    case JOB.EXTRACT_CHECKLIST:
      return (await import('./aiExtractor.js')).handleChecklistExtract(job);
    // processVaultExpiry, not one of the inner handlers: it runs the warning
    // sweep, the lapsed sweep AND the pending-upload prune. Calling an inner
    // function directly is how the other two would silently never fire.
    case JOB.VAULT_EXPIRY:
      return (await import('./vaultExpiry.js')).processVaultExpiry();
    case JOB.DELIVER_NOTIFICATION:
      return (await import('./notifier.js')).handleDeliverNotification(job);
    case JOB.MATCH_TENDER:
    default:
      return handleTenderMatched(job);
  }
};

export default { handleTenderMatched, processMatch };
