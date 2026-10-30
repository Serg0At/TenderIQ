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
 * notice about an invitation (ticket 07), a contract notice with the
 * tender's results (ticket 08), or a notice that its lots failed (ticket 09).
 */
const UPLOAD_JOBS = {
  invitation: { name: JOB.PAPER_INVITATION, tag: 'paper' },
  amendment: { name: JOB.PAPER_AMENDMENT, tag: 'amendment' },
  contract: { name: JOB.PAPER_CONTRACT, tag: 'contract' },
  failed: { name: JOB.PAPER_FAILED, tag: 'failed' },
};

/** The listings of what became of a tender — its contract or its failure — whose word is an upload. */
const RESULT_LISTINGS = new Set(['contract', 'failed']);

/** The listings whose uploads are invitations: what the covered window and the notice index are about (ticket 31). */
export const invitationListings = () =>
  getSourceConfig(SOURCE).listingPaths.filter((l) => listingKind(l.slug) === 'invitation');

const INDEXED_KINDS = new Set(['invitation', 'eauction']);

const indexId = (item) => {
  if (item.kind === 'paper') return paperNoticeId(item.externalId);
  if (item.kind === 'armeps' || item.kind === 'eauction') return `${item.kind}:${item.externalId}`;
  return `other:${pathDigest(item.url)}`;
};

/**
 * A notice's `listing_notices` row, for the invitation listings (ticket 31)
 * and the e-auction one (ticket 34): "was an invitation of this code ever
 * published" is asked of the invitation listings, and the e-auction listing's
 * rows are what `sources:verify` counts against the e-auction tenders held.
 * Every notice on them, ingested or not — an e-auction link, an excluded
 * buyer's upload, a link nobody recognises was published all the same, and
 * leaving it out would let the covered window vouch that its code never was.
 * An ingested notice's id is its discovery-link id, so a title naming no code
 * finds its tender's. Null on any other listing.
 *
 * The e-auction listing's rows carry an id of their own (`listing:{slug}:…`):
 * a row is one per `(source, external_id)` and keeps the listing that wrote
 * it first, so a tmid shared with an invitation listing would otherwise count
 * for whichever sweep reached it first — and `publicityFacts` reads by listing.
 */
export const noticeIndex = (item, slug) => {
  const kind = listingKind(slug);
  if (!INDEXED_KINDS.has(kind)) return null;
  return {
    externalId: kind === 'invitation' ? indexId(item) : `listing:${slug}:${indexId(item)}`,
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
 * excluded buyers' uploads are counted and skipped; the e-auction listing is
 * indexed and counted, and nothing on it is ingested.
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

    // Discovery only, whatever its links say (ticket 34): the e-auction
    // listing is a coverage check, and an upload there is no invitation of
    // ours to read. None was seen; said rather than dropped.
    if (listingKind(slug) === 'eauction') {
      log.warn(`a ${item.kind} link on the e-auction listing — indexed, not ingested: ${item.url}`);
      return { tally: 'other', index };
    }

    if (item.kind === 'other') {
      log.warn(`unrecognised link target — not ingested: ${item.url}`);
      return { tally: 'other', index };
    }

    if (item.kind === 'paper' && excludedBuyer(item, getSourceConfig(SOURCE).excludedBuyers)) {
      return { tally: 'excluded', index };
    }

    // A contract or failure notice that links to armeps.am is not one: the
    // word is the upload (PPCM owns ARMEPS awards, ADR 0004). Counted, not
    // read. None was seen — 180 failure notices and every contract notice
    // read were uploads — but the link alone would otherwise re-read the
    // armeps.am page, which states no status.
    if (item.kind === 'armeps' && RESULT_LISTINGS.has(listingKind(slug))) return { tally: 'armeps' };

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
