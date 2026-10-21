import { DelayedError, UnrecoverableError } from 'bullmq';
import { getSourceConfig } from '../configs/sources.config.js';
import { getStorage, rawKey, tenderDocKey } from '../libs/storage/index.js';
import { fetchInvitation } from '../libs/adapters/source/gnumner/client.js';
import { fileFormat, noticeBodyCode, parseInvitation } from '../libs/adapters/source/gnumner/invitation.parser.js';
import { parseContractNotice } from '../libs/adapters/source/gnumner/contract.parser.js';
import { invitationArchive, isOfficeFile, uploadedName } from '../libs/adapters/source/gnumner/invitation.files.js';
import {
  amendmentNoticeId,
  contractNoticeDigest,
  contractNoticeId,
  noticeIdOfContract,
  observeAmendment,
  observeContract,
  pathDigest,
} from '../libs/adapters/source/gnumner/observation.js';
import { bufferSource } from '../libs/adapters/archive/zip.js';
import TenderDocumentService from '../services/tenderDocument.service.js';
import AddendumService from '../services/addendum.service.js';
import { noticeOfJob, storedNotice } from '../services/paperNotice.service.js';
import { deriveStatus, lookupsFor, normalizeCode, resolve } from '../services/resolution.service.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';
import tenders from '../repositories/tender.repo.js';
import tenderSources from '../repositories/tenderSource.repo.js';
import unmatchedResults from '../repositories/unmatchedResult.repo.js';
import { alertsQueue, ingestFetchQueue, ingestNormalizeQueue, maintenanceQueue } from '../queues/index.js';
import { JOB, PRIORITY, matchJobId } from '../queues/names.js';
import { isFinalAttempt } from '../utils/attempts.js';
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
 * One upload's bytes, through the rate limit: a throttle defers the job
 * without spending an attempt. A path gnumner does not have answers 200 with
 * its error page — a missing file, not a format to count, and a stored copy
 * would be replayed as an upload — so HTML throws, and the failed job is the
 * record.
 */
const fetchUpload = async (job, token, path) => {
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
      throw new UnrecoverableError(`[${SOURCE}] upload ${path} is over the ${MAX_DOCUMENT_BYTES}-byte cap`);
    }
    throw error;
  }
  if (!result.bytes?.length) throw new Error(`[${SOURCE}] upload ${path} returned an empty body`);
  const format = fileFormat(result.bytes);
  if (format === 'html') throw new Error(`[${SOURCE}] upload ${path} returned an HTML page, not a file`);
  return { ...result, format };
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

  const result = await fetchUpload(job, token, path);
  const { bytes, format } = result;
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
 * and serves it like any other document. A changed invitation is a new
 * upload; once it has joined its run (ticket 07) its set is compared with the
 * one before it, as for every source (ticket 18).
 *
 * A job carrying a re-post's join (`data.amendment`) owes the tender one
 * amendment alert whatever becomes of the document — the same guarantee as
 * e-auction's (workers/documents.js): disabled, unreadable, refused or out of
 * attempts, it is raised without the file list.
 */
export const handlePaperDocuments = async (job) => {
  const { amendment = null } = job.data;
  const owed = () => AddendumService.raiseJoin(amendment, { priority: job.opts?.priority });
  let result;
  try {
    result = await storePaperDocuments(job);
  } catch (error) {
    if (amendment && (error instanceof UnrecoverableError || isFinalAttempt(job))) await owed();
    throw error;
  }
  if (amendment && !result.amendmentRaised) await owed();
  return result;
};

const storePaperDocuments = async (job) => {
  const { invitationId, url, fileName, amendment = null } = job.data;
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
    amendment,
  });
  // Queued only after the tender is saved, so a miss is a race worth retrying.
  if (facts.skipped === 'unknown_tender') {
    throw new Error(`[${SOURCE}] documents of ${invitationId}: no tender links it yet`);
  }

  log.info(`invitation stored as a document: ${manifest?.length ?? '?'} files, ${facts.lotsWritten} lots`);
  return { stored: true, storageKey: archiveKey, files: manifest?.length ?? null, ...facts };
};

/**
 * A notice on gnumner's amendment listing (ticket 07): fetched, stored under
 * its content hash, and recorded on its tender (`recordAmendment`). Its
 * content is never read, so its format decides nothing: a .doc, .rar or .pdf
 * attaches like a .docx (decided 2026-10-21).
 */
export const handlePaperAmendment = async (job, token) => {
  if (!isNotice(job.data)) {
    throw new UnrecoverableError('paper.amendment needs the notice: an upload path, slug, title and publishedAt');
  }
  const { path, fileType = null } = job.data;
  const { bytes, format, contentType } = await fetchUpload(job, token, path);
  const hash = sha256(bytes);

  if (!(await sourcePayloads.existsWithHash(SOURCE, amendmentNoticeId(hash), hash))) {
    const storage = await getStorage();
    const key = rawKey({ source: SOURCE, ref: amendmentNoticeId(hash), hash, ext: extensionOf(format, fileType) });
    await storage.put(key, bytes, { contentType: contentType || 'application/octet-stream' });
    await sourcePayloads.record({ source: SOURCE, ref: amendmentNoticeId(hash), storageKey: key, hash });
  }

  const notice = { ...noticeOfJob(job.data), seenAt: new Date(job.timestamp) };
  return recordAmendment({ hash, notice, priority: job.opts?.priority ?? PRIORITY.LIVE });
};

/**
 * One stored amendment notice → its tender, through the resolution module:
 * an addendum document when its code — the title's, else a readable .docx's
 * body's — matches exactly one open paper tender, an unmatched result when it
 * matches none or two (or no code is known), nothing when the code is another
 * channel's. The stored file is otherwise served, never read; running this
 * again — a retry, a re-listed notice — decides the same and, by rule 1 and
 * the document row, writes nothing twice.
 */
export const recordAmendment = async ({ hash, notice, priority = PRIORITY.LIVE }) => {
  const log = logger.child({ job: JOB.PAPER_AMENDMENT, source: SOURCE, amendment: hash.slice(0, 12) });
  const stored = await sourcePayloads.findLatestByRef(SOURCE, amendmentNoticeId(hash));
  if (!stored) throw new UnrecoverableError(`[${SOURCE}] no stored amendment notice ${hash}`);
  const storage = await getStorage();
  const bytes = Buffer.from(await storage.get(stored.storage_key));

  // The body is read only for a title with no code, and only for its code.
  const bodyCode = notice.procedureCode ? null : noticeBodyCode(bytes);
  const observation = observeAmendment(notice, { externalId: hash, bodyCode });
  const decision = resolve(observation, await tenders.findCandidates(lookupsFor(observation)));

  if (decision.action === 'unmatched') {
    await unmatchedResults.record({
      source: SOURCE,
      externalRef: observation.externalId,
      procedureCode: observation.procedureCode,
      reason: decision.reason,
      candidateTenderIds: decision.candidateIds,
      payloadHash: hash,
      seenAt: stored.fetched_at,
    });
    log.warn(`amendment notice unmatched (${decision.reason})`, {
      code: observation.procedureCode,
      candidates: decision.candidateIds,
    });
    return { unmatched: decision.reason };
  }
  if (decision.action !== 'link') {
    log.info(`amendment notice for ${observation.procedureCode} skipped — ${decision.reason ?? decision.action}`);
    return { skipped: decision.reason ?? decision.action };
  }

  // Served like an invitation, from a ZIP: an archive of files as it is,
  // anything else — a .docx, .doc, .pdf, .rar — as the one entry of one.
  const ext = stored.storage_key.match(/\.([a-z0-9]+)$/)?.[1] ?? 'bin';
  const fileName = uploadedName(notice.url, `amendment.${ext}`);
  const plainZip = fileFormat(bytes) === 'zip' && !isOfficeFile(bytes);
  const archive = invitationArchive(bytes, { format: plainZip ? 'zip' : ext, fileName });
  const archiveKey = tenderDocKey({ source: SOURCE, sourceId: amendmentNoticeId(hash), hash, ext: 'zip' });
  await storage.put(archiveKey, archive, { contentType: 'application/zip' });

  let manifest = null;
  try {
    manifest = await TenderDocumentService.manifestOf(bufferSource(archive));
  } catch (error) {
    log.warn(`amendment notice could not be listed: ${error.message}`);
  }

  const recorded = await AddendumService.recordNotice({
    link: {
      tenderId: decision.tenderId,
      source: SOURCE,
      externalId: observation.externalId,
      url: observation.url,
      role: observation.role,
      seenAt: notice.seenAt,
    },
    facts: {
      source: SOURCE,
      externalId: observation.externalId,
      sourceId: `${SOURCE}:${observation.externalId}`,
      url: observation.url,
      storageKey: archiveKey,
      taxId: null,
      cpvCode: null,
      cpvCodes: [],
      lots: [],
      manifest,
    },
    fileName,
    priority,
  });
  // A matched notice was resolved from a candidate that existed a moment ago.
  if (recorded.skipped) throw new Error(`[${SOURCE}] amendment ${hash}: ${recorded.skipped}`);

  // Only when the link is new, as in the normalizer: one already linked was never unmatched since.
  if (decision.rule !== 'link') {
    await unmatchedResults.markResolved({ source: SOURCE, externalRef: observation.externalId, tenderId: decision.tenderId });
  }
  return { tenderId: decision.tenderId, ...(recorded.addendum ? { version: recorded.addendum.version, notified: recorded.addendum.notify } : {}) };
};

/**
 * A notice on gnumner's contract-concluded listing (ticket 08): fetched,
 * stored under its notice id (`contract:{path digest}`), and recorded on its
 * tender as that tender's results (`recordContract`).
 *
 * `reason: 'retry'` re-reads a notice that was left unmatched, from storage
 * and with no request, once a tender of its code has appeared
 * (`queueContractRetries`). The notice is rebuilt from the listing page it
 * was stored with, as a paper invitation's are.
 */
export const handlePaperContract = async (job, token) => {
  const priority = job.opts?.priority ?? PRIORITY.LIVE;

  if (job.data.reason === 'retry') {
    const { externalRef } = job.data;
    if (!/^contract:[0-9a-f]{24}$/.test(String(externalRef ?? ''))) {
      throw new UnrecoverableError(`paper.contract retry needs a contract notice id, got ${JSON.stringify(externalRef)}`);
    }
    const notice = await storedNotice(noticeIdOfContract(externalRef));
    if (!notice) throw new UnrecoverableError(`[${SOURCE}] contract notice ${externalRef}: no listing record to re-read it from`);
    return recordContract({ externalId: externalRef, notice, priority });
  }

  if (!isNotice(job.data)) {
    throw new UnrecoverableError('paper.contract needs the notice: an upload path, slug, title and publishedAt');
  }
  const { path, fileType = null } = job.data;
  const { bytes, format, contentType } = await fetchUpload(job, token, path);
  const hash = sha256(bytes);
  const externalId = contractNoticeId(path);

  if (!(await sourcePayloads.existsWithHash(SOURCE, externalId, hash))) {
    const storage = await getStorage();
    const key = rawKey({ source: SOURCE, ref: externalId, hash, ext: extensionOf(format, fileType) });
    await storage.put(key, bytes, { contentType: contentType || 'application/octet-stream' });
    await sourcePayloads.record({ source: SOURCE, ref: externalId, storageKey: key, hash });
  }

  const notice = { ...noticeOfJob(job.data), seenAt: new Date(job.timestamp) };
  return recordContract({ externalId, notice, priority });
};

/**
 * One stored contract notice → its tender's results, through the resolution
 * module: the bids and awards of the lots it covers and `awarded`, when its
 * code, the paper channel and the invitation's date match exactly one tender;
 * an unmatched result when they match none or two, or the file cannot be
 * read; nothing when the code is another channel's. Reads only storage, so
 * running it again — a retry, a re-listed notice, the re-read once a tender
 * appears — decides the same and writes the same rows.
 */
export const recordContract = async ({ externalId, notice, priority = PRIORITY.LIVE }) => {
  const log = logger.child({ job: JOB.PAPER_CONTRACT, source: SOURCE, contract: externalId });
  const stored = await sourcePayloads.findLatestByRef(SOURCE, externalId);
  if (!stored) throw new UnrecoverableError(`[${SOURCE}] no stored contract notice ${externalId}`);
  const storage = await getStorage();
  const bytes = Buffer.from(await storage.get(stored.storage_key));

  const observation = observeContract(notice, { externalId, parsed: parseContractNotice(bytes) });
  for (const warning of observation.warnings) log.warn(warning);
  const decision = resolve(observation, await tenders.findCandidates(lookupsFor(observation)));

  if (decision.action === 'unmatched') {
    await unmatchedResults.record({
      source: SOURCE,
      externalRef: externalId,
      procedureCode: observation.procedureCode,
      reason: decision.reason,
      candidateTenderIds: decision.candidateIds,
      payloadHash: stored.hash,
      seenAt: stored.fetched_at,
    });
    log.warn(`contract notice unmatched (${decision.reason})`, {
      code: observation.procedureCode,
      candidates: decision.candidateIds,
      ...(observation.unreadable ? { format: observation.unreadable.format } : {}),
    });
    return { unmatched: decision.reason };
  }
  if (decision.action !== 'link') {
    log.info(`contract notice for ${observation.procedureCode} skipped — ${decision.reason ?? decision.action}`);
    return { skipped: decision.reason ?? decision.action };
  }

  // The notice's own word, through the owners table: gnumner's contract
  // notice is the paper channel's award source (ADR 0004).
  const status = deriveStatus(
    {
      submissionChannel: observation.submissionChannel,
      links: [{ source: SOURCE, status: observation.status }],
      current: decision.tender.status,
      deadlineAt: decision.tender.deadlineAt,
    },
    new Date()
  );
  const result = await tenders.recordResults({
    tenderId: decision.tenderId,
    expectedStatus: decision.tender.status,
    status,
    link: {
      source: SOURCE,
      externalId,
      url: observation.url,
      role: observation.role,
      observedStatus: null,
      seenAt: notice.seenAt ?? stored.fetched_at,
    },
    lots: observation.ledger,
  });

  // Only when the link is new, as in the normalizer.
  if (decision.rule !== 'link') {
    await unmatchedResults.markResolved({ source: SOURCE, externalRef: externalId, tenderId: decision.tenderId });
  }

  // The status move is an amendment like an e-auction settling: the matcher
  // hears of it, and its open rule (deadline ahead) decides whether anyone
  // is told.
  if (result.event) {
    await alertsQueue.add(
      JOB.MATCH_TENDER,
      { tenderId: result.tenderId, event: result.event, version: result.version, changedFields: result.changedFields },
      { jobId: matchJobId(result.tenderId, result.version), priority }
    );
  }
  // Awards landed, so "what similar tenders were won at" moved. Keyed on the
  // file, so the same notice read again recomputes nothing new.
  if (result.awards > 0) {
    await maintenanceQueue.add(
      JOB.RECOMPUTE_BENCHMARKS,
      { tenderId: result.tenderId },
      { jobId: `benchmarks-${result.tenderId}-${contractNoticeDigest(externalId)}-${stored.hash.slice(0, 12)}`, priority }
    );
  }

  log.info(`contract notice recorded: ${result.bids} bids, ${result.awards} awards, tender ${status}`, { tenderId: decision.tenderId });
  return { tenderId: decision.tenderId, status, bids: result.bids, awards: result.awards, ...(result.event ? { version: result.version } : {}) };
};

/**
 * Re-read every contract notice left unmatched under a code a paper tender
 * has just been created with — "a later-appearing tender picks it up". A
 * contract notice is usually read weeks after its invitation, but a cold
 * start, a backfill or an invitation that failed and was retried can put the
 * result first. One job per notice, from storage, no request; resolution
 * decides again, so one that still matches nothing stays unmatched.
 */
export const queueContractRetries = async ({ tenderId, referenceCode, priority = PRIORITY.LIVE }) => {
  const key = normalizeCode(referenceCode);
  if (!key) return 0;
  const open = await unmatchedResults.findOpenByCode({ source: SOURCE, refPrefix: 'contract:', key });
  for (const row of open) {
    await ingestFetchQueue.add(
      JOB.PAPER_CONTRACT,
      { source: SOURCE, reason: 'retry', externalRef: row.external_ref },
      { jobId: `${SOURCE}-contract-retry-${contractNoticeDigest(row.external_ref)}-${tenderId}`, priority }
    );
  }
  if (open.length) logger.info(`[${SOURCE}] tender ${tenderId} (${referenceCode}): re-reading ${open.length} unmatched contract notices`);
  return open.length;
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

export default {
  handlePaperInvitation,
  handlePaperDocuments,
  handlePaperAmendment,
  recordAmendment,
  handlePaperContract,
  recordContract,
  queueContractRetries,
  paperDocumentsJob,
  paperRefresher,
};
