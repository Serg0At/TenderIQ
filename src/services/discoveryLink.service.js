import { getSourceConfig } from '../configs/sources.config.js';
import { listingUrl } from '../libs/adapters/source/gnumner/client.js';
import { observeArmepsNotice, observePaperNotice } from '../libs/adapters/source/gnumner/observation.js';
import { lookupsFor, resolve } from './resolution.service.js';
import tenders from '../repositories/tender.repo.js';
import tenderSources from '../repositories/tenderSource.repo.js';
import { logger } from '../utils/logger.js';

/**
 * Record a gnumner notice's link on the tender it discovered.
 *
 * Which tender is decided by the resolution module, through the pointer the
 * notice carries (ADR 0004, rule 2) — never assumed from the job. A notice
 * resolves only to a tender its detail source already created: if there is
 * none yet (the detail's normalize is still queued, or it had no buyer),
 * nothing is written, and the normalize job that carries this discovery
 * writes it.
 *
 * `seenAt` is when the listing showed the notice — the discovery job's
 * enqueue time — not when this runs.
 */
const link = async (observation, seenAt) => {
  const decision = resolve(observation, await tenders.findCandidates(lookupsFor(observation)));
  if (decision.action !== 'link') {
    // `create` is the resolution module's answer for an unlinked discovery;
    // gnumner never creates from a notice, so it means "not yet".
    if (decision.action === 'unmatched') {
      logger.warn(
        `[gnumner] notice for ${observation.pointer.source}:${observation.pointer.externalId} unmatched (${decision.reason})`,
        { candidates: decision.candidateIds }
      );
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
    // Which link this notice is a notice of: a paper invitation reads its own
    // notices back through it (services/paperNotice.service.js).
    pointsTo: `${observation.pointer.source}:${observation.pointer.externalId}`,
    seenAt: seenAt ? new Date(seenAt) : new Date(),
  });
  return { linked: true, tenderId: decision.tenderId };
};

/** The gnumner link of an ARMEPS tender, which an `armeps.detail` job carries as `discovery`. */
export const linkDiscovery = async ({ discovery, pointer }) => {
  const listing = getSourceConfig('gnumner').listingPaths.find((l) => l.slug === discovery.slug);
  const observation = observeArmepsNotice(discovery, {
    resourceId: pointer.externalId,
    listingUrl: listing ? listingUrl(listing.path) : null,
  });
  return link(observation, discovery.seenAt);
};

/**
 * The notice of a paper tender, pointing at its invitation by content hash
 * (`invitationId`). A file uploaded twice is two of these on one tender.
 */
export const linkPaperDiscovery = async ({ discovery, invitationId }) =>
  link(observePaperNotice(discovery, { invitationId }), discovery.seenAt);

export default { linkDiscovery, linkPaperDiscovery };
