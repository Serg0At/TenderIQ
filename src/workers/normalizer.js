import { createId } from '@paralleldrive/cuid2';
import { UnrecoverableError } from 'bullmq';
import db from '../libs/knex.js';
import { getStorage } from '../libs/storage/index.js';
import { parseListing } from '../libs/adapters/source/armeps/listing.parser.js';
import sourcePayloads from '../repositories/sourcePayload.repository.js';
import { stableHash } from '../utils/hash.js';
import { logger } from '../utils/logger.js';
import { validateNormalizedTender } from '../validations/index.js';

const LISTING_BUYER = {
  id: 'armeps:listing-buyer',
  name: 'Unknown buyer (ARMEPS listing)',
  role: 'buyer',
};

const fieldHash = (tender) =>
  stableHash({
    title: tender.title,
    buyerId: tender.buyerId,
    cpvCode: tender.cpvCode,
    procedureType: tender.procedureType,
    status: tender.status,
    estimatedValue:
      tender.estimatedValue === null || tender.estimatedValue === undefined
        ? tender.estimatedValue
        : String(tender.estimatedValue),
    currency: tender.currency,
    publishedAt: tender.publishedAt,
    deadlineAt: tender.deadlineAt,
    qnaDeadlineAt: tender.qnaDeadlineAt,
  });

const mapArmepsListing = (row) => ({
  sourceId: `armeps:${row.sourceId}`,
  title: row.title,
  buyerId: LISTING_BUYER.id,
  procedureType: 'open_competition',
  status: 'active',
  currency: 'AMD',
  publishedAt: row.publishedAt,
  deadlineAt: row.deadlineAt,
  qnaDeadlineAt: null,
  cpvCode: null,
  estimatedValue: null,
});

const mapTender = (source, row) => {
  if (source === 'armeps') return mapArmepsListing(row);
  throw new UnrecoverableError(`no tender normalizer is registered for source "${source}"`);
};

const readArmepsRow = async ({ sourceId, storageKey }) => {
  const storage = await getStorage();
  if (!(await storage.head(storageKey))) {
    throw new UnrecoverableError(
      `raw payload is unavailable: "${storageKey}". Restore it in the configured storage backend or re-scrape this notice.`
    );
  }
  const html = await storage.get(storageKey);
  const row = parseListing(html.toString('utf8')).rows.find((candidate) => candidate.sourceId === sourceId);
  if (!row) {
    throw new UnrecoverableError(
      `raw payload "${storageKey}" does not contain ARMEPS notice "${sourceId}"`
    );
  }
  return row;
};

const changedFields = (before, after) =>
  Object.keys(after).filter((key) => {
    const oldValue = before[key] instanceof Date ? before[key].toISOString() : before[key];
    const newValue = after[key] instanceof Date ? after[key].toISOString() : after[key];
    return oldValue !== newValue;
  });

/**
 * Normalize one retained listing notice into its current tender record.
 *
 * `tenders.source_id` is unique in the current schema, so amendments update
 * that one row and advance `version`.  Once historical tender rows are added,
 * this transaction can insert the next version without changing the mapper.
 */
export const normalizeTender = async ({ source, sourceId, ref, hash, storageKey }) => {
  if (!source || !sourceId || !ref || !hash || !storageKey) {
    throw new UnrecoverableError('normalize.tender requires source, sourceId, ref, hash, and storageKey');
  }

  // Jobs are at-least-once and can finish out of order. Do not let an older
  // listing snapshot overwrite a newer one that was queued after it.
  const latestPayload = await sourcePayloads.findLatestByRef(source, ref);
  if (!latestPayload || latestPayload.hash !== hash) {
    return { event: null, skipped: 'stale_payload' };
  }

  const row = source === 'armeps'
    ? await readArmepsRow({ sourceId, storageKey })
    : null;
  const tender = validateNormalizedTender(mapTender(source, row));

  const candidateHash = fieldHash(tender);
  const result = await db.transaction(async (trx) => {
    await trx('parties')
      .insert(LISTING_BUYER)
      .onConflict('id')
      .merge({ name: LISTING_BUYER.name, role: LISTING_BUYER.role });

    const existing = await trx('tenders').where({ source_id: tender.sourceId }).forUpdate().first();
    if (!existing) {
      const id = createId();
      await trx('tenders').insert({
        id,
        source_id: tender.sourceId,
        title: tender.title,
        buyer_id: tender.buyerId,
        cpv_code: tender.cpvCode,
        procedure_type: tender.procedureType,
        status: tender.status,
        estimated_value: tender.estimatedValue,
        currency: tender.currency,
        published_at: tender.publishedAt,
        deadline_at: tender.deadlineAt,
        qna_deadline_at: tender.qnaDeadlineAt,
        version: 1,
        is_latest: true,
      });
      return { event: 'TenderIngested', tenderId: id, version: 1 };
    }

    const existingHash = fieldHash({
      title: existing.title,
      buyerId: existing.buyer_id,
      cpvCode: existing.cpv_code,
      procedureType: existing.procedure_type,
      status: existing.status,
      estimatedValue: existing.estimated_value === null ? null : String(existing.estimated_value),
      currency: existing.currency,
      publishedAt: existing.published_at,
      deadlineAt: existing.deadline_at,
      qnaDeadlineAt: existing.qna_deadline_at,
    });
    if (existingHash === candidateHash) return { event: null, tenderId: existing.id, version: existing.version };

    const update = {
      title: tender.title,
      buyer_id: tender.buyerId,
      cpv_code: tender.cpvCode,
      procedure_type: tender.procedureType,
      status: tender.status,
      estimated_value: tender.estimatedValue,
      currency: tender.currency,
      published_at: tender.publishedAt,
      deadline_at: tender.deadlineAt,
      qna_deadline_at: tender.qnaDeadlineAt,
      version: existing.version + 1,
      is_latest: true,
    };
    await trx('tenders').where({ id: existing.id }).update(update);
    return {
      event: 'TenderAmended',
      tenderId: existing.id,
      version: existing.version + 1,
      changedFields: changedFields(existing, update),
    };
  });

  // There is no event bus yet. Returning this minimal event payload gives the
  // BullMQ completion record a durable hand-off point for matcher/notifier work.
  if (result.event) logger.info(`[normalizer] ${result.event}`, result);
  return result;
};

/** Processor for the ingest.normalize queue. */
export const processIngestNormalize = async (job) => normalizeTender(job.data);

export default { normalizeTender, processIngestNormalize };
