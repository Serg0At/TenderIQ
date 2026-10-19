import { DelayedError, UnrecoverableError } from 'bullmq';
import { getSourceConfig } from '../configs/sources.config.js';
import { getStorage, rawKey, tenderDocKey } from '../libs/storage/index.js';
import { fetchCft, fetchDocuments, documentsUrl } from '../libs/adapters/source/armeps/client.js';
import { canonicalPage, isCftPage } from '../libs/adapters/source/armeps/cft.parser.js';
import {
  documentSetHash,
  documentManifest,
  tenderStructureEntry,
  parseTenderStructure,
  cpvForLots,
} from '../libs/adapters/source/armeps/documents.js';
import { ZipError, bufferSource, listEntries, openEntry } from '../libs/adapters/archive/zip.js';
import TenderDocumentService from '../services/tenderDocument.service.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';
import tenders from '../repositories/tender.repo.js';
import tenderSources from '../repositories/tenderSource.repo.js';
import { ingestNormalizeQueue } from '../queues/index.js';
import { JOB, PRIORITY } from '../queues/names.js';
import { sha256 } from '../utils/hash.js';
import { MAX_DOCUMENT_BYTES } from '../utils/http.js';
import { RateLimitedError } from '../utils/rateLimiter.js';
import { logger } from '../utils/logger.js';
import { linkDiscovery } from '../services/discoveryLink.service.js';

/**
 * armeps.am: the detail page and the documents of every ARMEPS tender.
 *
 * There is no listing. A page is fetched because gnumner discovered it
 * (`armeps.detail` with `discovery`), or because the refresh is re-checking an
 * unsettled tender (`armeps.detail` with `reason: 'refresh'`). Everything after
 * the fetch is the shared path: raw payload, `normalize.tender`, the
 * resolution module, `saveNormalized`.
 */
const SOURCE = 'armeps';

const isResourceId = (value) => /^\d+$/.test(String(value ?? ''));

/** Queue a normalize of the latest stored page, under an hourly id of its own. */
const renormalize = async (resourceId, priority) => {
  const ref = `detail:${resourceId}`;
  const latest = await sourcePayloads.findLatestByRef(SOURCE, ref);
  if (!latest) return;
  const bucket = Math.floor(Date.now() / (60 * 60 * 1000));
  await ingestNormalizeQueue.add(
    JOB.NORMALIZE_TENDER,
    { source: SOURCE, sourceId: String(resourceId), ref, hash: latest.hash, storageKey: latest.storage_key, priority },
    { jobId: `${SOURCE}-renormalize-${resourceId}-${latest.hash.slice(0, 12)}-${bucket}`, priority }
  );
};

const delayOnThrottle = async (error, job, token) => {
  if (error instanceof RateLimitedError) {
    await job.moveToDelayed(Date.now() + error.retryAfterMs, token);
    throw new DelayedError();
  }
  throw error;
};

/**
 * Fetch one CfT page and hand it to the normalizer.
 *
 * Stored under ref `detail:{resourceId}`, the same shape as e-auction's, so
 * `normalize:replay` and reindex treat it like any other detail page. What is
 * stored is the canonical page (cft.parser.js#canonicalPage): the raw HTML
 * with its per-request session id and clock removed, so that an unchanged
 * tender hashes the same and writes nothing.
 */
export const handleArmepsDetail = async (job, token) => {
  const { resourceId, discovery = null, priority = PRIORITY.LIVE } = job.data;
  if (!isResourceId(resourceId)) {
    throw new UnrecoverableError(`armeps.detail needs a numeric resourceId, got ${JSON.stringify(resourceId)}`);
  }
  const log = logger.child({ job: JOB.ARMEPS_DETAIL, source: SOURCE, resourceId });

  let result;
  try {
    result = await fetchCft(resourceId);
  } catch (error) {
    await delayOnThrottle(error, job, token);
  }

  const body = result.response.body;
  // An id that does not exist, or is not public, answers 200 with the
  // "you must log in" home page. Nothing is stored: it is not a CfT, and a
  // stored copy would be replayed as one. The failed job is the record.
  if (!isCftPage(body)) {
    throw new Error(`[${SOURCE}] resourceId ${resourceId} did not return a CfT page (not public, or no such tender)`);
  }

  // When the listing showed the notice, for the gnumner link's `last_seen_at`.
  const notice = discovery ? { ...discovery, seenAt: new Date(job.timestamp).toISOString() } : null;
  const pointer = { source: SOURCE, externalId: String(resourceId) };

  const page = canonicalPage(body);
  const ref = `detail:${resourceId}`;
  const hash = sha256(page);

  // Unchanged: the page says nothing new, so no normalize job runs. The
  // source still showed it just now, and the notice that led here may be a
  // new one (the same tender on a second listing) — both are recorded here,
  // since nothing downstream will.
  if (await sourcePayloads.existsWithHash(SOURCE, ref, hash)) {
    await tenderSources.touch({ source: SOURCE, externalId: resourceId });
    if (notice) await linkDiscovery({ discovery: notice, pointer });
    // The page states no status; it is read off the deadline. An unchanged
    // page whose deadline has passed is therefore still news, and only the
    // normalizer derives it — so a refresh re-runs it over the stored page,
    // once per hour at most. An unchanged tender writes nothing.
    if (job.data.reason === 'refresh') await renormalize(resourceId, priority);
    return { unchanged: true };
  }

  const storage = await getStorage();
  const key = rawKey({ source: SOURCE, ref, hash, ext: 'html' });
  await storage.put(key, page, { contentType: 'text/html; charset=utf-8' });

  const inserted = await sourcePayloads.record({ source: SOURCE, ref, storageKey: key, hash });
  if (!inserted) {
    if (notice) await linkDiscovery({ discovery: notice, pointer });
    return { unchanged: true };
  }

  // The notice travels with the page into the normalizer, which writes the
  // gnumner link once the tender exists. The job id is the page's hash, as
  // for e-auction: one normalize per distinct page.
  await ingestNormalizeQueue.add(
    JOB.NORMALIZE_TENDER,
    { source: SOURCE, sourceId: String(resourceId), ref, hash, storageKey: key, priority, discovery: notice, fresh: true },
    { jobId: `${SOURCE}-normalize-${resourceId}-${hash.slice(0, 12)}`, priority }
  );

  log.info('CfT stored, normalize enqueued', { storageKey: key });
  return { stored: true, storageKey: key };
};

/**
 * The document stage's job for a normalized ARMEPS tender, or null.
 *
 * Unlike e-auction's, it is queued for every newly stored page (`fresh`), not
 * only on a changed tender: an addendum adds a row to the document table
 * without moving any field the amendment check reads. Not for a replay or a
 * refresh re-normalize of a page already seen — its documents were queued
 * when it was stored, and BullMQ keeps too few completed jobs for the id
 * alone to stop ~500 tenders re-downloading every three hours. The job id
 * carries the table's fingerprint, so a duplicate that does get through costs
 * one download and writes nothing.
 */
export const armepsDocumentsJob = (observation, { sourceId, result, fresh, priority }) => {
  const { documents } = observation;
  if (!documents?.listed || !(fresh || result.event)) return null;
  // The ZIP holds every file regardless; what is lost past the first page of
  // the table is only the buyer's language tag for those files.
  if (documents.total > documents.listed) {
    logger.warn(
      `[${SOURCE}] CfT ${sourceId} lists ${documents.total} documents, the page showed ${documents.listed} — ` +
        'languages of the rest come from their file names'
    );
  }
  return {
    name: JOB.ARMEPS_DOCUMENTS,
    data: { source: SOURCE, resourceId: sourceId, files: documents.files, cpv: documents.cpv },
    opts: { jobId: `${SOURCE}-docs-${sourceId}-${documents.fingerprint}`, priority },
  };
};

const readEntry = async (source, entry) => {
  const chunks = [];
  for await (const chunk of await openEntry(source, entry, { maxBytes: 5 * 1024 * 1024 })) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

/**
 * Download one tender's contract documents, store them, list them, and write
 * its lots from the Tender Structure XML.
 *
 * The archive is generated on request and its bytes differ on every download,
 * so its identity is the set of files the buyer published
 * (documents.js#documentSetHash): that hash names the stored object and
 * dedupes `source_payloads`, so a re-download of an unchanged set writes
 * nothing, and a new addendum is a new object beside the old one.
 */
export const handleArmepsDocuments = async (job, token) => {
  const { resourceId, files = [], cpv = [] } = job.data;
  if (!isResourceId(resourceId)) {
    throw new UnrecoverableError(`armeps.documents needs a numeric resourceId, got ${JSON.stringify(resourceId)}`);
  }
  if (!getSourceConfig(SOURCE).downloadDocuments) return { skipped: 'documents_disabled' };
  const log = logger.child({ job: JOB.ARMEPS_DOCUMENTS, source: SOURCE, resourceId });

  let result;
  try {
    result = await fetchDocuments(resourceId);
  } catch (error) {
    // Over the cap is a property of the archive, not a transient failure.
    if (/maxContentLength/.test(error.message)) {
      throw new UnrecoverableError(`[${SOURCE}] documents of ${resourceId} are over the ${MAX_DOCUMENT_BYTES}-byte cap`);
    }
    await delayOnThrottle(error, job, token);
  }

  const { bytes } = result;
  if (!bytes?.length) throw new Error(`[${SOURCE}] documents of ${resourceId} returned an empty body`);

  const archive = bufferSource(bytes);
  let entries;
  try {
    entries = await listEntries(archive);
  } catch (error) {
    // Not a ZIP is what an error page looks like here; retried, then failed.
    if (error instanceof ZipError) {
      throw new Error(`[${SOURCE}] documents of ${resourceId} are not a readable ZIP: ${error.message}`);
    }
    throw error;
  }

  const ref = `documents:${resourceId}`;
  const hash = documentSetHash(entries, resourceId);
  if (await sourcePayloads.existsWithHash(SOURCE, ref, hash)) return { unchanged: true };

  const storage = await getStorage();
  const archiveKey = tenderDocKey({ source: SOURCE, sourceId: resourceId, hash, ext: 'zip' });
  await storage.put(archiveKey, bytes, { contentType: result.contentType || 'application/zip' });

  // A listing failure is recorded as NULL ("unlisted"), as for e-auction: the
  // lots are worth more than the list, and the manifest backfill can retry
  // from storage.
  let manifest = null;
  try {
    manifest = TenderDocumentService.validManifest(documentManifest(entries, { resourceId, pageDocuments: files }));
  } catch (error) {
    log.warn(`documents could not be listed: ${error.message}`);
  }

  const structureEntry = tenderStructureEntry(entries, resourceId);
  const structure = structureEntry ? parseTenderStructure(await readEntry(archive, structureEntry)) : null;
  if (!structure) {
    log.warn(`no readable Tender Structure XML among ${entries.length} entries — lots not written`);
  } else if (structure.declaredLots !== null && structure.declaredLots !== structure.lots.length) {
    log.warn(`Tender Structure XML declares ${structure.declaredLots} lots and lists ${structure.lots.length}`);
  }
  const lots = cpvForLots(structure?.lots ?? [], cpv);

  const facts = await tenders.applyInvitationFacts({
    source: SOURCE,
    sourceId: `${SOURCE}:${resourceId}`,
    kind: 'contract_documents',
    url: documentsUrl(resourceId),
    storageKey: archiveKey,
    taxId: null,
    cpvCode: null,
    lots: lots.map(({ lotNumber, cpvCode, name }) => ({ lotNumber, itemSequence: 0, cpvCode, name })),
    manifest,
  });
  // The normalizer queues this only after the tender is saved, so a miss is
  // a race worth retrying, not a document to drop.
  if (facts.skipped === 'unknown_tender') {
    throw new Error(`[${SOURCE}] documents of ${resourceId}: no tender armeps:${resourceId} yet`);
  }

  await sourcePayloads.record({ source: SOURCE, ref, storageKey: archiveKey, hash });

  log.info(`documents stored: ${manifest?.length ?? '?'} files, ${facts.lotsWritten} lots`, facts);
  return { stored: true, storageKey: archiveKey, files: manifest?.length ?? null, ...facts };
};

/**
 * The ARMEPS refresh, for scraper.js#handleRefreshSweep: which tenders, and
 * the job that re-reads one. Its ids are `armeps-refresh-…`, never
 * `armeps-detail-…`, so a refresh can never swallow a discovery or the
 * reverse.
 */
export const armepsRefresher = {
  find: ({ refreshWindowDays, maxRefreshBatch }) =>
    tenders.findUnsettledLinks({ source: SOURCE, windowDays: refreshWindowDays, limit: maxRefreshBatch }),
  job: (row, bucket) => ({
    name: JOB.ARMEPS_DETAIL,
    data: { source: SOURCE, resourceId: row.external_id, reason: 'refresh' },
    opts: { jobId: `${SOURCE}-refresh-${row.external_id}-${bucket}`, priority: PRIORITY.LIVE },
  }),
};

export default { handleArmepsDetail, handleArmepsDocuments, armepsDocumentsJob, armepsRefresher };
