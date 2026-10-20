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

const procedureTypeOf = (slug) => {
  const listing = getSourceConfig(SOURCE).listingPaths.find((l) => l.slug === slug);
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

/** One notice re-read from the listing page it was stored with, or null when it was never stored. */
const storedNotice = async (noticeId) => {
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
 * job carries, and those already linked to its tender.
 */
export const noticesFor = async ({ invitationId, discovery = null }) => {
  const notices = discovery ? [noticeOfJob(discovery)] : [];
  const have = new Set(notices.map((n) => paperNoticeId(n.path)));

  const links = await tenderSources.listSiblings({ source: SOURCE, externalId: invitationId, prefix: 'paper:' });
  for (const { external_id: noticeId } of links) {
    if (have.has(noticeId)) continue;
    const notice = await storedNotice(noticeId);
    if (notice) notices.push(notice);
    have.add(noticeId);
  }
  return notices;
};

export default { noticesFor, noticeOfJob };
