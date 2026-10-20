import { DelayedError, UnrecoverableError } from 'bullmq';
import { getSourceConfig } from '../configs/sources.config.js';
import { getStorage, rawKey, tenderDocKey } from '../libs/storage/index.js';
import { fetchInvitation } from '../libs/adapters/source/gnumner/client.js';
import { fileFormat, parseInvitation } from '../libs/adapters/source/gnumner/invitation.parser.js';
import { invitationArchive, uploadedName } from '../libs/adapters/source/gnumner/invitation.files.js';
import { pathDigest } from '../libs/adapters/source/gnumner/observation.js';
import { bufferSource } from '../libs/adapters/archive/zip.js';
import TenderDocumentService from '../services/tenderDocument.service.js';
import AddendumService from '../services/addendum.service.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';
import tenders from '../repositories/tender.repo.js';
import tenderSources from '../repositories/tenderSource.repo.js';
import { ingestNormalizeQueue } from '../queues/index.js';
import { JOB, PRIORITY } from '../queues/names.js';
import { sha256 } from '../utils/hash.js';
import { MAX_DOCUMENT_BYTES } from '../utils/http.js';
import { RateLimitedError } from '../utils/rateLimiter.js';
import { logger } from '../utils/logger.js';

/**
 * Paper tenders: the invitation a gnumner notice uploaded, read into a tender.
 *
 * A paper tender has no page — the uploaded .docx (or .zip) is the whole of
 * it. It is fetched because the listing found a notice (`paper.invitation`
 * with the notice's fields), and from then on everything is the shared path:
 * the raw file in storage and `source_payloads`, `normalize.tender`, the
 * resolution module, `saveNormalized`.
 *
 * Its identity is the file's content hash, not the upload's path. A buyer
 * sometimes posts the same file twice, minutes apart, under a new path —
 * five byte-identical pairs among 56 uploads on 2026-10-19/20. The second is
 * one more notice on the same tender, never a second tender.
 */
const SOURCE = 'gnumner';

const ref = (invitationId) => `detail:${invitationId}`;

/** An invitation's id is the sha256 of its bytes. */
const isInvitationId = (value) => /^[0-9a-f]{64}$/.test(String(value ?? ''));

/** The stored ref's extension: what the bytes are, so the unsupported-format count can read it off the key. */
const extensionOf = (format, fileType) => {
  if (format === 'zip') return fileType === 'docx' ? 'docx' : 'zip';
  return format === 'unknown' ? 'bin' : format;
};

const isNotice = (data) =>
  typeof data.path === 'string' &&
  // An upload on gnumner's own host, the only thing a paper notice points at
  // (client.js builds the URL from it); anything else is not worth a retry.
  data.path.startsWith('/website/images/') &&
  typeof data.slug === 'string' &&
  !Number.isNaN(Date.parse(data.publishedAt ?? '')) &&
  typeof data.title === 'string';

/**
 * How long a second notice's normalize waits. A file uploaded twice is listed
 * twice on one page, so both fetches run seconds apart and the first upload's
 * normalize is usually still queued; run together, both would create the
 * tender and the loser would retry on the unique `source_id` (seen on
 * 2026-10-21). The retry is the guarantee — this only makes it rare.
 */
const SECOND_NOTICE_DELAY_MS = 60 * 1000;

/** Queue a normalize of the stored invitation, under an id of the caller's. */
const renormalize = async (invitationId, { priority, discovery = null, tag, delay = 0 }) => {
  const latest = await sourcePayloads.findLatestByRef(SOURCE, ref(invitationId));
  if (!latest) return false;
  await ingestNormalizeQueue.add(
    JOB.NORMALIZE_TENDER,
    { source: SOURCE, sourceId: invitationId, ref: latest.ref, hash: latest.hash, storageKey: latest.storage_key, priority, discovery },
    { jobId: `${SOURCE}-renormalize-${invitationId.slice(0, 12)}-${tag}`, priority, delay }
  );
  return true;
};

/**
 * Fetch one uploaded invitation, store it, and hand it to the normalizer.
 *
 * Whether the file can be read is not decided here: an .rar is stored like a
 * .docx, and the normalizer counts it (invitation.parser.js, the format
 * check). So a converter added later replays every one of them from storage.
 *
 * `reason: 'refresh'` is the paper refresh (paperRefresher): no request, only
 * a re-normalize of the stored file, so a tender whose deadline has passed
 * closes.
 */
export const handlePaperInvitation = async (job, token) => {
  const { priority = PRIORITY.LIVE } = job.data;

  if (job.data.reason === 'refresh') {
    const { invitationId, bucket } = job.data;
    if (!isInvitationId(invitationId)) {
      throw new UnrecoverableError(`paper.invitation refresh needs an invitation hash, got ${JSON.stringify(invitationId)}`);
    }
    return { renormalized: await renormalize(invitationId, { priority, tag: `refresh-${bucket}` }) };
  }

  if (!isNotice(job.data)) {
    throw new UnrecoverableError('paper.invitation needs the notice: an upload path, slug, title and publishedAt');
  }
  const { path, fileType = null } = job.data;
  const log = logger.child({ job: JOB.PAPER_INVITATION, source: SOURCE, notice: pathDigest(path) });

  let result;
  try {
    result = await fetchInvitation(path);
  } catch (error) {
    if (error instanceof RateLimitedError) {
      await job.moveToDelayed(Date.now() + error.retryAfterMs, token);
      throw new DelayedError();
    }
    // Over the cap is a property of the file, not a transient failure.
    if (/maxContentLength/.test(error.message)) {
      throw new UnrecoverableError(`[${SOURCE}] invitation ${path} is over the ${MAX_DOCUMENT_BYTES}-byte cap`);
    }
    throw error;
  }

  const { bytes } = result;
  if (!bytes?.length) throw new Error(`[${SOURCE}] invitation ${path} returned an empty body`);
  // A path gnumner does not have answers 200 with its error page. That is a
  // missing file, not a format to count, and a stored copy would be replayed
  // as an upload. The failed job is the record.
  const format = fileFormat(bytes);
  if (format === 'html') throw new Error(`[${SOURCE}] invitation ${path} returned an HTML page, not a file`);

  const invitationId = sha256(bytes);
  // When the listing showed the notice, for its link's `last_seen_at`.
  const discovery = { ...job.data, seenAt: new Date(job.timestamp).toISOString() };
  // One per notice: the same file under a second notice is that notice's own job.
  const noticeTag = `${pathDigest(path)}-${String(job.data.listingHash ?? '').slice(0, 12)}`;

  // The same bytes are stored already: an upload posted twice, or a notice
  // whose title changed over an unchanged file. Nothing is stored, and the
  // stored file is normalized again with this notice, which links it — after
  // the tender's save, so a first upload still in the normalize queue is not
  // a race. A tender that has not moved writes nothing.
  if (await sourcePayloads.existsWithHash(SOURCE, ref(invitationId), invitationId)) {
    await tenderSources.touch({ source: SOURCE, externalId: invitationId });
    await renormalize(invitationId, { priority, discovery, tag: noticeTag, delay: SECOND_NOTICE_DELAY_MS });
    return { unchanged: true, invitationId };
  }

  const storage = await getStorage();
  const ext = extensionOf(format, fileType);
  const key = rawKey({ source: SOURCE, ref: ref(invitationId), hash: invitationId, ext });
  await storage.put(key, bytes, { contentType: result.contentType || 'application/octet-stream' });

  const inserted = await sourcePayloads.record({ source: SOURCE, ref: ref(invitationId), storageKey: key, hash: invitationId });
  if (!inserted) {
    await renormalize(invitationId, { priority, discovery, tag: noticeTag, delay: SECOND_NOTICE_DELAY_MS });
    return { unchanged: true, invitationId };
  }

  await ingestNormalizeQueue.add(
    JOB.NORMALIZE_TENDER,
    { source: SOURCE, sourceId: invitationId, ref: ref(invitationId), hash: invitationId, storageKey: key, priority, discovery, fresh: true },
    { jobId: `${SOURCE}-normalize-${invitationId.slice(0, 12)}`, priority }
  );

  log.info(`invitation stored (.${ext}), normalize enqueued`, { storageKey: key });
  return { stored: true, storageKey: key, invitationId, format: ext };
};

/**
 * The document stage's job for a normalized paper tender, or null: once per
 * newly stored file, as for ARMEPS. Nothing is downloaded — the file is the
 * one the invitation fetch stored — so it costs no request.
 */
export const paperDocumentsJob = (observation, { sourceId, result, fresh, priority }) => {
  if (!(fresh || result.event) || !observation.url) return null;
  return {
    name: JOB.PAPER_DOCUMENTS,
    data: { source: SOURCE, invitationId: sourceId, url: observation.url, fileName: uploadedName(observation.url) },
    opts: { jobId: `${SOURCE}-docs-${sourceId.slice(0, 24)}`, priority },
  };
};

/**
 * Store a paper tender's invitation as its document, list it, and write its
 * lots — all from the stored file.
 *
 * The archive is the upload itself when it is a .zip, and the .docx wrapped
 * in a one-entry ZIP otherwise (invitation.files.js), so the tender page lists
 * and serves it like any other document. A paper tender is one file, so it
 * holds one document set: a changed invitation is a new upload, and its
 * amendment is ticket 07's.
 */
export const handlePaperDocuments = async (job) => {
  const { invitationId, url, fileName } = job.data;
  if (!isInvitationId(invitationId) || typeof url !== 'string' || typeof fileName !== 'string') {
    throw new UnrecoverableError('paper.documents needs an invitation hash and its url');
  }
  if (!getSourceConfig(SOURCE).downloadDocuments) return { skipped: 'documents_disabled' };
  const log = logger.child({ job: JOB.PAPER_DOCUMENTS, source: SOURCE, invitation: invitationId.slice(0, 12) });

  const stored = await sourcePayloads.findLatestByRef(SOURCE, ref(invitationId));
  if (!stored) throw new UnrecoverableError(`[${SOURCE}] no stored invitation ${invitationId}`);
  const storage = await getStorage();
  const bytes = Buffer.from(await storage.get(stored.storage_key));

  const parsed = parseInvitation(bytes);
  if (!parsed.readable) return { skipped: 'unreadable' };

  const archive = invitationArchive(bytes, { format: parsed.format, fileName });
  const archiveKey = tenderDocKey({ source: SOURCE, sourceId: invitationId, hash: invitationId, ext: 'zip' });
  await storage.put(archiveKey, archive, { contentType: 'application/zip' });

  // A listing failure is recorded as NULL ("unlisted"), as for the other
  // sources: the lots are worth more than the list.
  let manifest = null;
  try {
    manifest = await TenderDocumentService.manifestOf(bufferSource(archive));
  } catch (error) {
    log.warn(`invitation could not be listed: ${error.message}`);
  }

  const facts = await AddendumService.recordDocuments({
    facts: {
      source: SOURCE,
      externalId: invitationId,
      sourceId: `${SOURCE}:${invitationId}`,
      kind: 'invitation',
      url,
      storageKey: archiveKey,
      taxId: null,
      cpvCode: null,
      // The tender's codes came from this same file through the normalizer,
      // so none are passed and they stand.
      cpvCodes: [],
      lots: parsed.document.lots.map(({ lotNumber, cpvCode, name }) => ({ lotNumber, itemSequence: 0, cpvCode, name })),
      manifest,
    },
    priority: job.opts?.priority,
  });
  // Queued only after the tender is saved, so a miss is a race worth retrying.
  if (facts.skipped === 'unknown_tender') {
    throw new Error(`[${SOURCE}] documents of ${invitationId}: no tender links it yet`);
  }

  log.info(`invitation stored as a document: ${manifest?.length ?? '?'} files, ${facts.lotsWritten} lots`);
  return { stored: true, storageKey: archiveKey, files: manifest?.length ?? null, ...facts };
};

/**
 * The paper refresh, for scraper.js#handleRefreshSweep: paper tenders whose
 * deadline has passed while they still say open, each re-normalized from
 * storage. Ids `gnumner-refresh-…`, never a notice's, so a refresh cannot
 * swallow a discovery.
 */
export const paperRefresher = {
  find: ({ refreshWindowDays, maxRefreshBatch }) =>
    tenders.findPaperPastDeadline({ windowDays: refreshWindowDays, limit: maxRefreshBatch }),
  job: (row, bucket) => ({
    name: JOB.PAPER_INVITATION,
    data: { source: SOURCE, invitationId: row.external_id, reason: 'refresh', bucket },
    opts: { jobId: `${SOURCE}-refresh-${row.external_id.slice(0, 24)}-${bucket}`, priority: PRIORITY.LIVE },
  }),
};

export default { handlePaperInvitation, handlePaperDocuments, paperDocumentsJob, paperRefresher };
