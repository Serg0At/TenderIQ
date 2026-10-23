import { getSourceConfig } from '../configs/sources.config.js';
import { fetchListing } from '../libs/adapters/source/gnumner/client.js';
import { JOB, PRIORITY } from '../queues/names.js';
import { pathDigest, paperNoticeId, paperNoticeRef } from '../libs/adapters/source/gnumner/observation.js';
import { stableHash } from '../utils/hash.js';

const SOURCE = 'gnumner';

/**
 * Newest publish datetime (epoch ms) seen by a *completed* sweep of a listing.
 *
 * gnumner's listings carry no ids, so this is the analogue of eauction's tid
 * watermark: each listing is sorted newest-first by publish datetime, so a
 * page whose oldest item is at or below the mark is a page we have already
 * read down to.
 */
const publishedWatermarkKey = (slug) => `sweep:published:${SOURCE}:${slug}`;

const noticeRef = (item) =>
  item.kind === 'paper' ? paperNoticeRef(paperNoticeId(item.externalId)) : `notice:${item.kind}:${item.externalId}`;

/**
 * Fields that define "this notice changed". The link target is the identity
 * here, so it is in the ref rather than the fingerprint; the title and the
 * announced window are what a buyer edits.
 */
const itemFingerprint = (item) =>
  stableHash({
    kind: item.kind,
    externalId: item.externalId,
    title: item.title,
    procedureCode: item.procedureCode,
    publishedAt: item.publishedAt,
    closesAt: item.closesAt,
  });

const excludedBuyer = (item, excludedBuyers) =>
  excludedBuyers.find(({ pattern }) => pattern.test(item.title)) ?? null;

/** What a listing's uploads are: invitations, unless the listing says otherwise. */
const listingKind = (slug) =>
  getSourceConfig(SOURCE).listingPaths.find((l) => l.slug === slug)?.kind ?? 'invitation';

/**
 * The job an upload becomes, by its listing: an invitation (ticket 06), a
 * notice about an invitation (ticket 07), or a contract notice with the
 * tender's results (ticket 08).
 */
const UPLOAD_JOBS = {
  invitation: { name: JOB.PAPER_INVITATION, tag: 'paper' },
  amendment: { name: JOB.PAPER_AMENDMENT, tag: 'amendment' },
  contract: { name: JOB.PAPER_CONTRACT, tag: 'contract' },
};

/** The listings whose uploads are invitations: what the covered window and the notice index are about (ticket 31). */
export const invitationListings = () =>
  getSourceConfig(SOURCE).listingPaths.filter((l) => listingKind(l.slug) === 'invitation');

/**
 * A notice's `listing_notices` row (ticket 31), for the invitation listings
 * only: "was an invitation of this code ever published" is asked of them.
 * Every notice on them, ingested or not — an e-auction link, an excluded
 * buyer's upload, a link nobody recognises was published all the same, and
 * leaving it out would let the covered window vouch that its code never was.
 * An ingested notice's id is its discovery-link id, so a title naming no code
 * finds its tender's. Null on any other listing.
 */
const indexId = (item) => {
  if (item.kind === 'paper') return paperNoticeId(item.externalId);
  if (item.kind === 'armeps' || item.kind === 'eauction') return `${item.kind}:${item.externalId}`;
  return `other:${pathDigest(item.url)}`;
};

export const noticeIndex = (item, slug) => {
  if (listingKind(slug) !== 'invitation') return null;
  return {
    externalId: indexId(item),
    listing: slug,
    procedureCode: item.procedureCode ?? null,
    publishedAt: item.publishedAt,
  };
};

const discoveryJob = (item, { slug, ref, hash }) => {
  const discovery = {
    source: SOURCE,
    slug,
    url: item.url,
    title: item.title,
    procedureCode: item.procedureCode,
    publishedAt: item.publishedAt.toISOString(),
    closesAt: item.closesAt ? item.closesAt.toISOString() : null,
    listingRef: ref,
    listingHash: hash,
  };

  if (item.kind === 'armeps') {
    return {
      name: JOB.ARMEPS_DETAIL,
      data: { source: 'armeps', resourceId: item.externalId, discovery },
      opts: { jobId: `armeps-detail-${item.externalId}-${hash.slice(0, 12)}`, priority: PRIORITY.LIVE },
    };
  }

  const upload = UPLOAD_JOBS[listingKind(slug)];
  return {
    name: upload.name,
    data: { source: SOURCE, path: item.externalId, fileType: item.fileType, ...discovery },
    opts: {
      jobId: `gnumner-${upload.tag}-${pathDigest(item.externalId)}-${hash.slice(0, 12)}`,
      priority: PRIORITY.LIVE,
    },
  };
};

/**
 * The gnumner board for the shared listing chain. Its per-notice decisions:
 * e-auction links and unrecognised targets are counted, never ingested;
 * excluded buyers' uploads are counted and skipped.
 */
export const gnumnerBoard = {
  source: SOURCE,
  watermarkKey: publishedWatermarkKey,
  markName: 'published',
  formatMark: (value) => new Date(value).toISOString(),

  read: async (listingPath, page) => {
    const result = await fetchListing(listingPath, page);
    return { ...result, entries: result.items };
  },

  markOf: (item) => item.publishedAt.getTime(),

  toNotice: (item, { slug, log }) => {
    const index = noticeIndex(item, slug);

    // Counted for coverage only. A tmid cannot be mapped to a tid today, and
    // the eauction board already ingests every e-auction directly.
    if (item.kind === 'eauction') return { tally: 'eauction', index };

    if (item.kind === 'other') {
      log.warn(`unrecognised link target — not ingested: ${item.url}`);
      return { tally: 'other', index };
    }

    if (item.kind === 'paper' && excludedBuyer(item, getSourceConfig(SOURCE).excludedBuyers)) {
      return { tally: 'excluded', index };
    }

    // A contract notice that links to armeps.am is an ARMEPS tender's result,
    // and PPCM owns those (ADR 0004): counted, not read. None was seen — the
    // listing's items are uploads — but the link alone would otherwise
    // re-read the armeps.am page.
    if (item.kind === 'armeps' && listingKind(slug) === 'contract') return { tally: 'armeps' };

    const ref = noticeRef(item);
    const hash = itemFingerprint(item);
    return { tally: item.kind, index, notice: { ref, hash, job: discoveryJob(item, { slug, ref, hash }) } };
  },

  // Per classification, for the coverage check: every block on the page is in
  // exactly one of these or in result.skipped.
  summarize: ({ result, tally, changed }) =>
    `${result.blocksSeen} blocks: ${tally.armeps ?? 0} armeps, ${tally.paper ?? 0} paper, ` +
    `${tally.eauction ?? 0} eauction, ${tally.excluded ?? 0} excluded, ${tally.other ?? 0} other, ` +
    `${result.skipped.duplicate} duplicate, ${result.skipped.noLink + result.skipped.noDate} unreadable; ` +
    `${changed} new/changed`,
};

export default { gnumnerBoard, noticeIndex, invitationListings };
