import { UnrecoverableError } from 'bullmq';
import { getSourceConfig } from '../configs/sources.config.js';
import { getStorage } from '../libs/storage/index.js';
import { parseDetail } from '../libs/adapters/source/eauction/detail.parser.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';
import tenders from '../repositories/tender.repo.js';
import { ingestFetchQueue, alertsQueue, maintenanceQueue } from '../queues/index.js';
import { JOB, PRIORITY } from '../queues/names.js';
import { sha256 } from '../utils/hash.js';
import { logger } from '../utils/logger.js';
import { validateNormalizedTender } from '../validations/index.js';

/**
 * Source payload -> domain entities. The only stage that writes tenders,
 * parties, awards and bids.
 *
 * It runs on its own queue so a mapping bug can be fixed and replayed straight
 * from object storage without re-crawling the source — which is also why this
 * file re-parses the stored HTML rather than trusting anything the fetch job
 * put in the job payload.
 */

/**
 * Fallback for a status the adapter does not recognise.
 *
 * Degrade, do not discard. Throwing here used to lose an entire tender — title,
 * buyer, deadline, the whole bid ledger — over one unrecognised label, and
 * missed tenders are the product's #1 churn cause. The site has ten lifecycle
 * states today and can add an eleventh whenever it likes.
 *
 * "Can a supplier still bid?" is answerable from the deadline alone, which is
 * the only thing `status` is load-bearing for downstream. The exact Armenian
 * label is preserved as `source_status`, so nothing is actually lost, and the
 * warning is what prompts adding it to STATUS properly.
 *
 * The clock lives here rather than in the parser, which must stay pure.
 */
const statusFromDeadline = (detail, sourceId) => {
  const fallback = detail.deadlineAt && detail.deadlineAt.getTime() < Date.now() ? 'closed' : 'active';
  logger.warn(
    `[normalizer] unmapped e-auction status ${JSON.stringify(detail.rawStatus)} on tender ` +
      `${sourceId} — stored as "${fallback}" from its deadline. Add it to STATUS in ` +
      'libs/adapters/source/eauction/detail.parser.js'
  );
  return fallback;
};

const mapEauctionDetail = (detail, sourceId) => {
  return {
    status: detail.status ?? statusFromDeadline(detail, sourceId),
    sourceStatus: detail.rawStatus ?? null,
    title: detail.title,
    referenceCode: detail.code,
    procedureType: detail.procedureType,
    goodsWorksServices: detail.goodsWorksServices,
    // Neither is published anywhere in the HTML. `cpvCode` arrives later from
    // the invitation archive via applyInvitationFacts.
    cpvCode: null,
    // `description` does NOT. It has no writer anywhere and no source to have
    // one: the docx's contract-subject line is the title verbatim, and the real
    // per-item text is already stored as tender_lots.name. The column is an
    // OCDS-shaped leftover — see docs/SCRAPER_WORKFLOW.md § 5. Do not "fix"
    // this by joining lot names into it.
    description: null,
    estimatedValue: detail.estimatedValue,
    currency: detail.currency,
    publishedAt: detail.publishedAt,
    deadlineAt: detail.deadlineAt,
    qnaDeadlineAt: detail.qnaDeadlineAt,
    auctionAt: detail.auctionAt,
    invitationUrl: detail.invitationUrl,
  };
};

const readPayload = async (storageKey) => {
  const storage = await getStorage();
  if (!(await storage.head(storageKey))) {
    throw new UnrecoverableError(
      `raw payload is unavailable: "${storageKey}". Restore it in the configured ` +
        'storage backend or re-scrape this notice.'
    );
  }
  const body = await storage.get(storageKey);
  return Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
};

export const normalizeTender = async ({
  source,
  sourceId,
  ref,
  hash,
  storageKey,
  priority = PRIORITY.LIVE,
}) => {
  if (!source || !sourceId || !ref || !hash || !storageKey) {
    throw new UnrecoverableError(
      'normalize.tender requires source, sourceId, ref, hash, and storageKey'
    );
  }
  if (source !== 'eauction') {
    throw new UnrecoverableError(`no tender normalizer is registered for source "${source}"`);
  }

  // A newer payload for this ref means this job is describing a page that has
  // already been superseded; normalizing it would walk the tender backwards.
  const latest = await sourcePayloads.findLatestByRef(source, ref);
  if (!latest || latest.hash !== hash) {
    return { event: null, skipped: 'stale_payload' };
  }

  const sourceConfig = getSourceConfig(source);
  const detail = parseDetail(await readPayload(storageKey), { baseUrl: sourceConfig.baseUrl });

  // Layout-health alarm, the detail-page counterpart to blocksSeen: a page that
  // parsed to no labels at all is a redesign, not an empty tender.
  if (detail.labelsSeen === 0) {
    throw new Error(
      `[normalizer] ${source} detail ${sourceId} yielded 0 label/value pairs — parser likely broken`
    );
  }

  // The ledger table was present and every row was rejected. That is a column
  // change, not an empty ledger — and persisting it would look identical to an
  // active tender that simply has no bids yet. Failing here is what keeps the
  // ledger-replace from being handed an empty result it would act on.
  if (detail.malformedLedgerRows > 0 && detail.lots.length === 0) {
    throw new Error(
      `[normalizer] ${source} detail ${sourceId}: bid ledger present but all ` +
        `${detail.malformedLedgerRows} rows failed the column check — ` +
        'Գնառաջարկներ layout likely changed'
    );
  }

  const tender = validateNormalizedTender(mapEauctionDetail(detail, sourceId));

  const result = await tenders.saveNormalized({
    source,
    sourceId: `${source}:${sourceId}`,
    buyerName: detail.buyerName,
    tender,
    lots: detail.lots,
  });

  if (result.skipped === 'no_buyer') {
    logger.warn(`[normalizer] ${source}:${sourceId} skipped — no buyer on the detail page`);
    return result;
  }

  // Enqueued from here rather than from the detail fetch because this is the
  // point at which the tender is known to exist in the database — the document
  // stage updates it by source_id and would otherwise race its own creation.
  //
  // The jobId is keyed on the invitation URL, NOT on the detail payload hash.
  // A tender walks Հրապարակված → Նախաաճուրդային → Աճուրդ → Շնորհում →
  // Ավարտված, so the detail hash changes about five times and a hash-keyed id
  // would re-download the same unchanged 600 KB archive on every one of them.
  // The content-hash check inside the handler only skips the storage write —
  // by then the request has already been paid for out of the 20/min budget.
  // The seed skips archives unless explicitly opted in — see backfillDocuments.
  const documentsWanted =
    sourceConfig.downloadDocuments &&
    (priority !== PRIORITY.BACKFILL || sourceConfig.backfillDocuments === true);

  if (result.event && detail.invitationUrl && documentsWanted) {
    await ingestFetchQueue.add(
      JOB.TENDER_DOCUMENTS,
      { source, sourceId, invitationUrl: detail.invitationUrl },
      {
        jobId: `${source}-docs-${sourceId}-${sha256(detail.invitationUrl).slice(0, 12)}`,
        priority,
      }
    );
  }

  // The domain event, delivered as a job. Only on a real change, so a
  // re-normalize that moved nothing cannot re-alert anyone.
  if (result.event) {
    await alertsQueue.add(
      JOB.MATCH_TENDER,
      { tenderId: result.tenderId, event: result.event, changedFields: result.changedFields ?? [] },
      {
        // Keyed on the tender's version so each amendment matches exactly once,
        // however many times this job is retried.
        jobId: `match-${result.tenderId}-v${result.version}`,
        priority,
      }
    );
  }

  // A settled tender changes what "similar tenders won at" means for its
  // categories, so its benchmarks are refreshed. Only when awards actually
  // landed — an active tender with no ledger moves no prices.
  if (result.event && (result.awards ?? 0) > 0) {
    await maintenanceQueue.add(
      JOB.RECOMPUTE_BENCHMARKS,
      { tenderId: result.tenderId },
      { jobId: `benchmarks-${result.tenderId}-v${result.version}`, priority }
    );
  }

  if (result.event) logger.info(`[normalizer] ${result.event}`, { sourceId, ...result });
  return result;
};

/** Processor for the ingest.normalize queue. */
export const processIngestNormalize = async (job) => normalizeTender(job.data);

export default { normalizeTender, processIngestNormalize };
