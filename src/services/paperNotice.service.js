import { getSourceConfig } from '../configs/sources.config.js';
import { getStorage } from '../libs/storage/index.js';
import { listingContext } from '../libs/adapters/source/gnumner/client.js';
import { parseListing } from '../libs/adapters/source/gnumner/listing.parser.js';
import { paperNoticeId, paperNoticeRef } from '../libs/adapters/source/gnumner/observation.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';
import tenderSources from '../repositories/tenderSource.repo.js';

/**
 * The gnumner notices that listed one paper invitation — what the file itself
 * does not say: when it was published, which its deadline is counted from;
 * the notice's title; and which listing it is on, which is its procedure type.
 *
 * Read from storage, so a replay computes exactly what the first run did: a
 * notice's `source_payloads` row points at the listing page it was read on,
 * and that page is parsed again. A first run also has the notice its job
 * carries, since the listing records the notice's row only after queueing
 * the job (listingChain.js) and the row may not exist yet.
 */
const SOURCE = 'gnumner';

/**
 * An invitation listing's procedure type; null on the amendment and contract
 * listings, whose uploads are not invitations. A listing names no `kind` for
 * invitations, as workers/gnumner.js#listingKind reads it.
 */
const procedureTypeOf = (slug) => {
  const listing = getSourceConfig(SOURCE).listingPaths.find((l) => l.slug === slug);
  if ((listing?.kind ?? 'invitation') !== 'invitation') return null;
  if (!listing?.procedureType) {
    throw new Error(`[${SOURCE}] listing "${slug}" names no procedureType in sources.config.js`);
  }
  return listing.procedureType;
};

/** A `paper.invitation` job's data, as a notice. */
export const noticeOfJob = (data) => ({
  path: data.path,
  url: data.url,
  title: data.title,
  procedureCode: data.procedureCode ?? null,
  publishedAt: data.publishedAt,
  closesAt: data.closesAt ?? null,
  slug: data.slug,
  procedureType: procedureTypeOf(data.slug),
});

/**
 * One notice re-read from the listing page it was stored with, or null when
 * it was never stored. `noticeId` is the listing's `paper:{digest}`.
 */
export const storedNotice = async (noticeId) => {
  const row = await sourcePayloads.findLatestByRef(SOURCE, paperNoticeRef(noticeId));
  if (!row) return null;

  const page = await sourcePayloads.findListingPage(SOURCE, row.storage_key);
  const slug = page?.ref.match(/^listing:(.+):p\d+$/)?.[1];
  if (!slug) throw new Error(`[${SOURCE}] notice ${noticeId}: no listing page stored under ${row.storage_key}`);

  const storage = await getStorage();
  const body = await storage.get(row.storage_key);
  const html = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  const item = parseListing(html, listingContext()).items.find(
    (entry) => entry.kind === 'paper' && paperNoticeId(entry.externalId) === noticeId
  );
  if (!item) throw new Error(`[${SOURCE}] notice ${noticeId} is not on the listing page stored for it`);

  return {
    path: item.externalId,
    url: item.url,
    title: item.title,
    procedureCode: item.procedureCode,
    publishedAt: item.publishedAt.toISOString(),
    closesAt: item.closesAt ? item.closesAt.toISOString() : null,
    slug,
    procedureType: procedureTypeOf(slug),
  };
};

/**
 * Every notice of the invitation `invitationId` (its content hash): the one a
 * job carries, and those already linked as pointing at it. Not every notice
 * of its tender: a tender a re-post joined holds another file's notices too
 * (ticket 07), and this file's deadline is counted from this file's.
 */
export const noticesFor = async ({ invitationId, discovery = null }) => {
  const notices = discovery ? [noticeOfJob(discovery)] : [];
  const have = new Set(notices.map((n) => paperNoticeId(n.path)));

  const links = await tenderSources.listPointingAt({ source: SOURCE, pointsTo: `${SOURCE}:${invitationId}` });
  for (const { external_id: noticeId } of links) {
    if (have.has(noticeId)) continue;
    const notice = await storedNotice(noticeId);
    if (notice) notices.push(notice);
    have.add(noticeId);
  }
  return notices;
};

/** A paper invitation's content hash: what a file's detail link is keyed on. */
const isFileLink = (link) => link.source === SOURCE && link.role === 'detail' && /^[0-9a-f]{64}$/.test(link.external_id);

/**
 * When each file of a paper run was published: the earliest notice of each,
 * as `observeInvitation` counts it. A run a re-post joined (ticket 07) holds
 * several files — the superseded ones too — and its `published_at` is only
 * the newest's; nothing else stores the others, so they are read back from
 * the listing pages their notices were stored with.
 */
export const runPublications = async (tenderId) => {
  const files = (await tenderSources.listForTender(tenderId)).filter(isFileLink);
  const dates = [];
  for (const file of files) {
    const notices = await noticesFor({ invitationId: file.external_id });
    const first = Math.min(...notices.map((n) => new Date(n.publishedAt).getTime()).filter(Number.isFinite));
    if (Number.isFinite(first)) dates.push(new Date(first));
  }
  return dates;
};

/**
 * Candidates for a contract notice, each paper run a re-post joined given
 * every file's publication (`runPublishedAt`), which rule 3 compares the
 * notice's invitation date with (decided 2026-10-23). Only those: a run of
 * one file is published when its `published_at` says, and reading notices
 * back costs a storage read per notice.
 */
export const withRunPublications = async (candidates) => ({
  ...candidates,
  byCode: await Promise.all(
    (candidates.byCode ?? []).map(async (tender) =>
      tender.submissionChannel === 'paper' && tender.replacedRuns
        ? { ...tender, runPublishedAt: await runPublications(tender.id) }
        : tender
    )
  ),
});

export default { noticesFor, noticeOfJob, storedNotice, runPublications, withRunPublications };
