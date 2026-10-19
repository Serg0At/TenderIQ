import { DelayedError } from 'bullmq';
import { getSourceConfig } from '../configs/sources.config.js';
import { fetchListing } from '../libs/adapters/source/gnumner/client.js';
import { JOB, PRIORITY } from '../queues/names.js';
import { sha256, stableHash } from '../utils/hash.js';

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

/**
 * The paper identity is the uploaded file's path, which can run long and
 * carries runs of spaces (non-ASCII characters in the original name become
 * spaces), so refs and job ids use a digest of it. The path itself travels in
 * the job.
 */
const pathDigest = (path) => sha256(path).slice(0, 24);

const noticeRef = (item) =>
  item.kind === 'paper'
    ? `notice:paper:${pathDigest(item.externalId)}`
    : `notice:${item.kind}:${item.externalId}`;

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

  return {
    name: JOB.PAPER_INVITATION,
    data: { source: SOURCE, path: item.externalId, fileType: item.fileType, ...discovery },
    opts: {
      jobId: `gnumner-paper-${pathDigest(item.externalId)}-${hash.slice(0, 12)}`,
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
    // Counted for coverage only. A tmid cannot be mapped to a tid today, and
    // the eauction board already ingests every e-auction directly.
    if (item.kind === 'eauction') return { tally: 'eauction' };

    if (item.kind === 'other') {
      log.warn(`unrecognised link target — not ingested: ${item.url}`);
      return { tally: 'other' };
    }

    if (item.kind === 'paper' && excludedBuyer(item, getSourceConfig(SOURCE).excludedBuyers)) {
      return { tally: 'excluded' };
    }

    const ref = noticeRef(item);
    const hash = itemFingerprint(item);
    return { tally: item.kind, notice: { ref, hash, job: discoveryJob(item, { slug, ref, hash }) } };
  },

  // Per classification, for the coverage check: every block on the page is in
  // exactly one of these or in result.skipped.
  summarize: ({ result, tally, changed }) =>
    `${result.blocksSeen} blocks: ${tally.armeps ?? 0} armeps, ${tally.paper ?? 0} paper, ` +
    `${tally.eauction ?? 0} eauction, ${tally.excluded ?? 0} excluded, ${tally.other ?? 0} other, ` +
    `${result.skipped.duplicate} duplicate, ${result.skipped.noLink + result.skipped.noDate} unreadable; ` +
    `${changed} new/changed`,
};

/**
 * Paper discoveries, whose consumer (ticket 06) has not landed yet, are
 * parked, not failed: moved back to delayed without spending an attempt, so
 * they stay recorded in Redis and the real handler picks them up the first
 * time it sees them. Replace this with the handler when it exists.
 */
const PARK_MS = 6 * 60 * 60 * 1000;

export const parkUntilConsumerExists = async (job, token) => {
  await job.moveToDelayed(Date.now() + PARK_MS, token);
  throw new DelayedError();
};

export default { gnumnerBoard, parkUntilConsumerExists };
