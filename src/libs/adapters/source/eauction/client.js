import { getSourceConfig } from '../../../../configs/sources.config.js';
import { fetchPage } from '../../../../utils/http.js';
import { acquire } from '../../../../utils/rateLimiter.js';
import { parseListing } from './listing.parser.js';

const SOURCE = 'eauction';

export class RateLimitedError extends Error {
  constructor(retryAfterMs) {
    super(`[${SOURCE}] rate limited, retry in ${retryAfterMs}ms`);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Page 1 is the bare listing path. Page N appends `start/<N>` — verified
 * against the live pager, e.g. https://eauction.armeps.am/hy/public/tender/start/2
 * NOT a query param, and NOT a bare number suffix.
 */
export const listingUrl = (listingPath, page = 1) => {
  const { baseUrl } = getSourceConfig(SOURCE);
  return page <= 1 ? `${baseUrl}${listingPath}` : `${baseUrl}${listingPath}start/${page}`;
};

/**
 * detailBaseUrl already ends in /tid/ — verified live detail links are
 * .../tender_details/tid/<sourceId>/ with a trailing slash.
 */
export const detailUrl = (sourceId) => {
  const { detailBaseUrl } = getSourceConfig(SOURCE);
  return `${detailBaseUrl}${encodeURIComponent(sourceId)}/`;
};

export const fetchListing = async (listingPath, page = 1, conditional = {}) => {
  const config = getSourceConfig(SOURCE);
  const url = listingUrl(listingPath, page);

  const waitMs = await acquire(SOURCE, config.rateLimit);
  if (waitMs > 0) throw new RateLimitedError(waitMs);

  const response = await fetchPage(url, conditional);

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

/**
 * Download an invitation archive. Same politeness gate as every other fetch —
 * rate limit first, then HTTP — so documents draw on the one shared budget
 * rather than getting an allowance of their own.
 */
export const fetchDocument = async (url) => {
  const config = getSourceConfig(SOURCE);

  const waitMs = await acquire(SOURCE, config.rateLimit);
  if (waitMs > 0) throw new RateLimitedError(waitMs);

  const response = await fetchPage(url, { binary: true });
  return { url, bytes: response.raw, contentType: response.contentType };
};

export default { listingUrl, fetchListing, detailUrl, fetchDetail, fetchDocument, RateLimitedError };
