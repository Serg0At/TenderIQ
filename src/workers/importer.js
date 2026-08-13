import { DelayedError, UnrecoverableError } from 'bullmq';
import { getSourceConfig } from '../configs/sources.config.js';
import { fetchDetail as clientFetchDetail, RateLimitedError } from '../libs/adapters/source/armeps/client.js';
import { sha256 } from '../utils/hash.js';
import { getStorage, rawKey } from '../libs/storage/index.js';
import sourcePayloads from '../repositories/sourcePayload.repository.js';
import { ingestNormalizeQueue } from '../queues/index.js';
import { JOB } from '../queues/names.js';
import { logger } from '../utils/logger.js';

/**
 * Fetch a tender detail page, store raw payload in object storage if changed,
 * record it in `source_payloads` and optionally enqueue normalization.
 */
export const fetchDetail = async ({ source, sourceId, ref = null, enqueueNormalize = true }) => {
  if (!source || !sourceId) throw new UnrecoverableError('fetchDetail requires source and sourceId');

  const cfg = getSourceConfig(source);
  const log = logger.child({ source, sourceId });

  const result = await clientFetchDetail(sourceId);
  if (result.notModified) {
    log.info('detail: 304 not modified');
    return { notModified: true, url: result.url };
  }

  const response = result.response;
  const payloadRef = ref || `notice:${sourceId}`;
  const hash = sha256(response.raw || response.body || '');

  if (await sourcePayloads.existsWithHash(source, payloadRef, hash)) {
    log.info('detail: known hash — skipping storage and normalize');
    return { notModified: true, url: result.url };
  }

  const storage = await getStorage();
  const key = rawKey({ source, ref: payloadRef, hash, ext: 'html' });
  await storage.put(key, response.raw || Buffer.from(String(response.body || ''), 'utf8'), {
    contentType: response.contentType || 'text/html',
  });

  await sourcePayloads.record({ source, ref: payloadRef, storageKey: key, hash });

  if (enqueueNormalize) {
    const jobId = `${source}-${sourceId}-${hash.slice(0, 12)}`;
    await ingestNormalizeQueue.add(
      JOB.NORMALIZE_TENDER,
      { source, sourceId, ref: payloadRef, hash, storageKey: key },
      { jobId }
    );
  }

  log.info('detail: stored and enqueued normalize', { storageKey: key });
  return { notModified: false, url: result.url, storageKey: key, hash };
};

export const processImporterJob = async (job, token) => {
  const { source, sourceId, ref } = job.data;
  try {
    return await fetchDetail({ source, sourceId, ref, enqueueNormalize: true });
  } catch (error) {
    if (error instanceof RateLimitedError) {
      await job.moveToDelayed(Date.now() + error.retryAfterMs, token);
      throw new DelayedError();
    }
    throw error;
  }
};

export default { fetchDetail, processImporterJob };
