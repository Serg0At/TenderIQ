import { UnrecoverableError } from 'bullmq';
import { JOB } from '../queues/names.js';
import savedSearches from '../repositories/savedSearch.repo.js';
import notifications from '../repositories/notification.repo.js';
import tenders from '../repositories/tender.repo.js';
import { getChannel } from '../services/delivery.service.js';
import { scoreMatch, MATCH_THRESHOLD } from '../services/matcher.service.js';
import { logger } from '../utils/logger.js';

/**
 * Fan a newly ingested or amended tender out to the saved searches it matches.
 *
 * Runs as a job rather than inline in the normalizer for two reasons: matching
 * against every profile is unbounded work that must not slow ingestion, and a
 * bug here must not roll back a tender that was correctly parsed.
 *
 * Amendments re-notify with a change summary — a moved deadline is exactly the
 * kind of thing a supplier needs to hear twice — but only for the fields that
 * actually moved, which is why `changedFields` rides along on the event.
 */
export const handleTenderMatched = async (job) => {
  const { tenderId, event = 'TenderIngested', changedFields = [] } = job.data;
  if (!tenderId) throw new UnrecoverableError('match.tender requires tenderId');

  const tender = await tenders.findDetail(tenderId);
  if (!tender) return { skipped: 'unknown_tender' };

  // Only live tenders are worth interrupting someone for: an award or a
  // cancellation is history, and alerting on it trains people to ignore alerts.
  if (!['active', 'planned', 'amended'].includes(tender.status)) {
    return { skipped: `status_${tender.status}` };
  }

  const candidate = {
    cpvCode: tender.cpv_code,
    lotCpvCodes: (tender.lots ?? []).map((l) => l.cpv_code).filter(Boolean),
    lotNames: (tender.lots ?? []).map((l) => l.name).filter(Boolean),
    title: tender.title,
    referenceCode: tender.reference_code,
    estimatedValue: tender.estimated_value,
    buyerRegion: tender.buyer_region,
  };

  const profiles = await savedSearches.listAll();
  const type = event === 'TenderAmended' ? 'amendment' : 'tender-match';

  let matched = 0;
  let delivered = 0;
  // Held for quiet hours, not lost — counted separately so a run that delivered
  // nothing because everyone was asleep is not read as a broken channel.
  let deferred = 0;

  for (const profile of profiles) {
    const result = scoreMatch(candidate, {
      cpvCodes: profile.cpv_codes ?? [],
      keywords: profile.keywords ?? [],
      regions: profile.regions ?? [],
      minValue: profile.min_value,
      maxValue: profile.max_value,
    });

    if (!result.matched || result.score < MATCH_THRESHOLD) continue;
    matched += 1;

    const { created, notification } = await notifications.createIfNew({
      organizationId: profile.organization_id,
      type,
      tenderId,
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
        score: result.score,
        reasons: result.reasons,
        // The "what changed" summary the spec asks for on re-notification.
        ...(type === 'amendment' ? { changedFields } : {}),
      },
    });

    // Already told them: dedupe is per (org, tender, type), so a re-run of the
    // matcher is silent rather than a second ping.
    if (!created) continue;

    // Fall back to the log channel when a profile names none, so a match is
    // never silently created and never delivered.
    const channels = profile.channels?.length ? profile.channels : ['log'];
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
      `[matcher] ${tender.reference_code}: ${matched} match(es), ${delivered} delivered` +
        (deferred ? `, ${deferred} deferred to quiet hours` : '')
    );
  }

  return { tenderId, event, profiles: profiles.length, matched, delivered, deferred };
};

/**
 * Both alert producers share this queue and therefore one concurrency budget —
 * a reminder sweep cannot starve a freshly ingested tender's match, which is
 * the one with a 5-minute delivery target.
 */
export const processMatch = async (job) => {
  switch (job.name) {
    case JOB.DEADLINE_REMINDER:
      return (await import('./reminder.js')).handleDeadlineReminders();
    case JOB.DELIVER_DEFERRED:
      return (await import('./notifier.js')).handleDeferredDeliveries();
    case JOB.MATCH_TENDER:
    default:
      return handleTenderMatched(job);
  }
};

export default { handleTenderMatched, processMatch };
