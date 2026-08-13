import { getSourceConfig } from '../../../../configs/sources.config.js';
import { fetchPage } from '../../../../utils/http.js';
import { acquire } from '../../../../utils/rateLimiter.js';
import { parseListing } from './listing.parser.js';

const SOURCE = 'armeps';

export class RateLimitedError extends Error {
  constructor(retryAfterMs) {
    super(`[${SOURCE}] rate limited, retry in ${retryAfterMs}ms`);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Page 1 has no suffix; page N is `<path>N` (the paths already end in "/"). */
export const listingUrl = (listingPath, page = 1) => {
  const { baseUrl } = getSourceConfig(SOURCE);
  return page <= 1 ? `${baseUrl}${listingPath}` : `${baseUrl}${listingPath}${page}`;
};

export const detailUrl = (sourceId) => {
  const { detailBaseUrl } = getSourceConfig(SOURCE);
  return `${detailBaseUrl}${encodeURIComponent(sourceId)}`;
};

export const fetchListing = async (listingPath, page = 1, conditional = {}) => {
  const config = getSourceConfig(SOURCE);
  const url = listingUrl(listingPath, page);
  console.log(url)

  const waitMs = await acquire(SOURCE, config.rateLimit);
  if (waitMs > 0) throw new RateLimitedError(waitMs);

  const response = await fetchPage(url, conditional);

  // gnumner sends no ETag/Last-Modified, so 304 never arrives from this source
  // in practice — handled anyway because the shared client supports it and
  // other sources (PPCM) may.
  if (response.notModified) {
    return { url, notModified: true, rows: [], blocksSeen: 0, pagination: null, response };
  }

  const { rows, blocksSeen, skipped, pagination } = parseListing(response.body);

  return { url, notModified: false, rows, blocksSeen, skipped, pagination, response };
};

export const fetchDetail = async (sourceId, conditional = {}) => {
  const config = getSourceConfig(SOURCE);
  const url = detailUrl(sourceId);

  const waitMs = await acquire(SOURCE, config.rateLimit);
  if (waitMs > 0) throw new RateLimitedError(waitMs);

  const response = await fetchPage(url, conditional);

  if (response.status === 304 || response.notModified) {
    return { url, notModified: true, response };
  }

  return { url, notModified: false, response };
};
export default { listingUrl, fetchListing, detailUrl, fetchDetail, RateLimitedError };
