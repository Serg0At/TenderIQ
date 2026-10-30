import { DelayedError, UnrecoverableError } from 'bullmq';
import { getSourceConfig } from '../configs/sources.config.js';
import { getStorage, tenderDocKey, tenderDocTextKey } from '../libs/storage/index.js';
import { fetchDocument } from '../libs/adapters/source/eauction/client.js';
import { RateLimitedError } from '../utils/rateLimiter.js';
import { parseInvitation } from '../libs/adapters/source/eauction/invitation.parser.js';
import { bufferSource } from '../libs/adapters/archive/zip.js';
import TenderDocumentService from '../services/tenderDocument.service.js';
import AddendumService from '../services/addendum.service.js';
import ChecklistExtractionService from '../services/checklistExtraction.service.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';
import { sha256 } from '../utils/hash.js';
import { JOB } from '../queues/names.js';
import { MAX_DOCUMENT_BYTES } from '../utils/http.js';
import { logger } from '../utils/logger.js';
import { endsJob } from '../utils/attempts.js';

/**
 * Invitation archive -> CPV code, buyer tax ID, per-lot item descriptions.
 *
 * These three fields appear NOWHERE in the HTML. The detail page has no CPV,
 * no tax ID and no item text; all of it lives inside `hraver.docx` in the
 * archive linked as "Հրավեր". That makes this stage the only way to populate
 * `tenders.cpv_code` and `parties.tax_id` — and CPV is what
 * `price_benchmarks.cpv_code` groups comparables by, so benchmarks stay
 * category-blind without it.
 *
 * Only `hraver.docx` is opened. The rest of the archive is per-lot technical
 * specification files whose format varies (across 43 sampled entries: 18 .xls,
 * 11 .rar, 11 .docx, 3 .xlsx). Those feed the later AI checklist, so no RAR or
 * spreadsheet reader is needed here — and the archive is retained whole in
 * object storage, so adding one later requires no re-download.
 */

const DOC_REF = (sourceId) => `invitation:${sourceId}`;

/**
 * The document stage's job for a normalized e-auction tender, or null.
 *
 * Only when the tender changed, and keyed on the invitation URL, NOT on the
 * detail payload hash. A tender walks Հրապարակված → Նախաաճուրդային → Աճուրդ →
 * Շնորհում → Ավարտված, so it is queued about five times. The id dedupes only
 * while a job with it still exists, so most of those reach the handler, which
 * ends them before any request once the tid's archive is stored (ticket 35).
 * Queued anyway rather than asked here, because knowing would cost a query on
 * every normalize, and each later event is the retry of a download that never
 * landed.
 */
export const eauctionDocumentsJob = (observation, { sourceId, result, priority }) => {
  const { source } = observation;
  const { invitationUrl } = observation.tender;
  if (!result.event || !invitationUrl) return null;
  return {
    name: JOB.TENDER_DOCUMENTS,
    data: { source, sourceId, invitationUrl },
    opts: { jobId: `${source}-docs-${sourceId}-${sha256(invitationUrl).slice(0, 12)}`, priority },
  };
};

/**
 * A job carrying a replacement's join (`data.amendment`, ticket 29) owes the
 * tender one amendment alert, and owes it whatever becomes of the archive: a
 * download that is disabled, already stored, refused or out of attempts still
 * raises it, only without the file list. A throttle is not an end — the job
 * comes back — so it raises nothing.
 */
export const handleTenderDocuments = async (job, token) => {
  const { amendment = null } = job.data;
  const owed = () => AddendumService.raiseJoin(amendment, { priority: job.opts?.priority });
  let result;
  try {
    result = await storeInvitation(job, token);
  } catch (error) {
    if (amendment && endsJob(job, error)) await owed();
    throw error;
  }
  if (amendment && !result.amendmentRaised) await owed();
  return result;
};

const storeInvitation = async (job, token) => {
  const { source, sourceId, invitationUrl, amendment = null } = job.data;
  const log = logger.child({ job: job.name, source, sourceId });

  if (!source || !sourceId || !invitationUrl) {
    throw new UnrecoverableError('tender.documents requires source, sourceId and invitationUrl');
  }
  const sourceConfig = getSourceConfig(source);
  if (!sourceConfig.downloadDocuments) {
    return { skipped: 'documents_disabled' };
  }

  /**
   * Origin check before any request is made.
   *
   * This is the one place where scraped content chooses a network destination:
   * the URL comes verbatim out of the tender page's "Հրավեր" link. Relative
   * hrefs are resolved against baseUrl by the detail parser, but an ABSOLUTE
   * href in the page names its own host, and without this the worker would
   * fetch it and store the response. Source text is data, never instructions —
   * and that includes not letting it pick where we connect.
   */
  let origin;
  try {
    origin = new URL(invitationUrl).origin;
  } catch {
    throw new UnrecoverableError(`invitation URL is not parseable: "${invitationUrl}"`);
  }
  const expected = new URL(sourceConfig.baseUrl).origin;
  if (origin !== expected) {
    throw new UnrecoverableError(
      `invitation URL origin ${origin} is not ${expected} — refusing to fetch off-source`
    );
  }

  // Stored once, never again (ticket 35). The site writes an invitation once,
  // at publication, and an amendment is a new tid (tickets 27 and 29), so a
  // tid that has an archive has its only one. Everything a stored archive
  // feeds — the manifest, lots, CPV codes, the buyer's ՀՎՀՀ, the open tender's
  // re-match (ticket 25) — was done before its row was recorded, below; a
  // second download ended at the content-hash check and did none of it again
  // either. What this saves is the request, out of the budget discovery uses.
  // ARMEPS re-issues its sets (ticket 18) and has its own job.
  const ref = DOC_REF(sourceId);
  if (await sourcePayloads.existsByRef(source, ref)) {
    return { skipped: 'already_stored' };
  }

  let result;
  try {
    result = await fetchDocument(invitationUrl);
  } catch (error) {
    if (error instanceof RateLimitedError) {
      await job.moveToDelayed(Date.now() + error.retryAfterMs, token);
      throw new DelayedError();
    }
    throw error;
  }

  const bytes = result.bytes;
  if (!bytes?.length) throw new Error(`[${source}] invitation ${sourceId} returned an empty body`);
  if (bytes.length > MAX_DOCUMENT_BYTES) {
    throw new UnrecoverableError(
      `[${source}] invitation ${sourceId} is ${bytes.length} bytes, over the ${MAX_DOCUMENT_BYTES} cap`
    );
  }

  // Content-hash dedupe, identical to the detail stage, for two jobs of one tid
  // that both passed the check above — one shared job id rules that out within
  // a queue, so it is `ingest.fetch` against `ingest.backfill`. It narrows that
  // window; the unique constraint behind `record()` is what decides it.
  const hash = sha256(bytes);
  if (await sourcePayloads.existsWithHash(source, ref, hash)) {
    return { unchanged: true };
  }

  const storage = await getStorage();
  const archiveKey = tenderDocKey({ source, sourceId, hash, ext: 'zip' });
  await storage.put(archiveKey, bytes, { contentType: result.contentType || 'application/zip' });

  // Parse before recording the payload: if extraction throws, the job retries
  // and the archive is re-read from storage rather than being marked done.
  let parsed;
  try {
    parsed = parseInvitation(bytes);
  } catch (error) {
    throw new Error(`[${source}] invitation ${sourceId} could not be opened: ${error.message}`);
  }

  // The extracted text is the input the AI checklist stage will read, so it is
  // stored beside the archive rather than re-derived on every use. Its hash
  // goes on the document row, so a checklist can tell whether its items came
  // from this text without reading it (ticket 24).
  let textHash = null;
  if (parsed.text) {
    await storage.put(tenderDocTextKey({ source, sourceId, hash }), parsed.text, {
      contentType: 'text/plain; charset=utf-8',
    });
    textHash = ChecklistExtractionService.documentHash(parsed.text);
  }

  // The archive's file list, for the tender page. Taken here, from bytes
  // already in memory, so no page view ever has to read the archive. A
  // failure is logged and recorded as NULL ("unlisted") rather than failing
  // the job: CPV and tax ID are worth more than the list, and the manifest
  // backfill can retry from storage without a re-download.
  let manifest = null;
  try {
    manifest = await TenderDocumentService.manifestOf(bufferSource(bytes));
  } catch (error) {
    log.warn(`invitation archive could not be listed: ${error.message}`);
  }

  // The invitation lives at one URL for the tender's whole life. If its files
  // ever differ from the set stored last, that is an addendum — but e-auction
  // amends by publishing a new tid, not a new file here (ticket 29).
  const facts = await AddendumService.recordDocuments({
    facts: {
      source,
      externalId: sourceId,
      sourceId: `${source}:${sourceId}`,
      url: invitationUrl,
      storageKey: archiveKey,
      taxId: parsed.taxId,
      cpvCode: parsed.dominantCpv,
      cpvCodes: parsed.cpvCodes,
      lots: parsed.lots,
      manifest,
      textHash,
    },
    priority: job.opts?.priority,
    amendment,
  });

  // Rows parsed but not one usable lot number means the first column of the
  // Ծածկագիր table moved. Without this it is silent: the lots simply are not
  // written, and `parsed.lots.length` below is non-zero so that warning misses
  // it — the same zero-usable-rows-on-a-200 failure the sweep alarms on.
  if (facts.lotsSeen > 0 && facts.lotsWritten === 0) {
    log.warn(
      `invitation parsed ${facts.lotsSeen} lot row(s) but none carried a usable ` +
        'lot number — the Ծածկագիր table layout likely changed'
    );
  }

  await sourcePayloads.record({ source, ref, storageKey: archiveKey, hash });

  // Loud when the archive yielded nothing: it means hraver.docx was missing or
  // its lot table was restructured, and CPV silently staying null would look
  // exactly like a tender that never had one.
  if (!parsed.taxId && parsed.lots.length === 0) {
    log.warn(
      `invitation parsed to no tax ID and no lots — entries: ${parsed.entries.slice(0, 6).join(', ')}`
    );
  }

  log.info(
    `invitation stored: ${parsed.lots.length} lots, cpv=${parsed.dominantCpv ?? '-'} ` +
      `(${parsed.cpvCodes.length} distinct), taxId=${parsed.taxId ?? '-'}`,
    facts
  );

  return {
    stored: true,
    storageKey: archiveKey,
    lots: parsed.lots.length,
    cpvCodes: parsed.cpvCodes.length,
    taxId: Boolean(parsed.taxId),
    files: manifest?.length ?? null,
    ...facts,
  };
};

export default { handleTenderDocuments, eauctionDocumentsJob };
