import { getSourceConfig } from '../configs/sources.config.js';
import { listingUrl } from '../libs/adapters/source/gnumner/client.js';
import { observeArmepsNotice } from '../libs/adapters/source/gnumner/observation.js';
import { lookupsFor, resolve } from './resolution.service.js';
import tenders from '../repositories/tender.repo.js';
import tenderSources from '../repositories/tenderSource.repo.js';
import { logger } from '../utils/logger.js';

/**
 * Record the gnumner link of an ARMEPS tender: the notice that discovered it,
 * which an `armeps.detail` job carries as `discovery`.
 *
 * Which tender is decided by the resolution module, through the pointer the
 * notice carries (ADR 0004, rule 2) — never assumed from the job. A notice
 * resolves only to a tender its armeps.am page already created: if there is
 * none yet (the page's normalize is still queued, or it had no buyer), nothing
 * is written, and the normalize job that carries this discovery writes it.
 *
 * `seenAt` is when the listing showed the notice — the discovery job's
 * enqueue time — not when this runs.
 */
export const linkDiscovery = async ({ discovery, pointer }) => {
  const listing = getSourceConfig('gnumner').listingPaths.find((l) => l.slug === discovery.slug);
  const observation = observeArmepsNotice(discovery, {
    resourceId: pointer.externalId,
    listingUrl: listing ? listingUrl(listing.path) : null,
  });

  const decision = resolve(observation, await tenders.findCandidates(lookupsFor(observation)));
  if (decision.action !== 'link') {
    // `create` is the resolution module's answer for an unlinked discovery;
    // gnumner never creates an ARMEPS tender, so it means "not yet".
    if (decision.action === 'unmatched') {
      logger.warn(`[gnumner] notice for ${pointer.source}:${pointer.externalId} unmatched (${decision.reason})`, {
        candidates: decision.candidateIds,
      });
    }
    return { linked: false };
  }

  await tenderSources.upsert({
    tenderId: decision.tenderId,
    source: observation.source,
    externalId: observation.externalId,
    url: observation.url,
    role: observation.role,
    observedStatus: null,
    seenAt: discovery.seenAt ? new Date(discovery.seenAt) : new Date(),
  });
  return { linked: true, tenderId: decision.tenderId };
};

export default { linkDiscovery };
