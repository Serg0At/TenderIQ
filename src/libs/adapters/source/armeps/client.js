import { getSourceConfig } from '../../../../configs/sources.config.js';
import { fetchPage } from '../../../../utils/http.js';
import { isAllowed, crawlDelayMs } from '../../../../utils/robots.js';
import { acquire } from '../../../../utils/rateLimiter.js';
import { parseListing } from './listing.parser.js';

const SOURCE = 'armeps';

/** Thrown when the source's budget is spent. Callers delay, they do not fail. */
export class RateLimitedError extends Error {
  constructor(retryAfterMs) {
    super(`[${SOURCE}] rate limited, retry in ${retryAfterMs}ms`);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Thrown when robots.txt forbids the URL. Not retryable — it will not change. */
export class RobotsDeniedError extends Error {
  constructor(url) {
    super(`[${SOURCE}] robots.txt disallows ${url}`);
    this.name = 'RobotsDeniedError';
  }
}

/** Page 1 has no suffix; page N is `<path>N` (the paths already end in "/"). */
export const listingUrl = (listingPath, page = 1) => {
  const { baseUrl } = getSourceConfig(SOURCE);
  return page <= 1 ? `${baseUrl}${listingPath}` : `${baseUrl}${listingPath}${page}`;
};

/**
 * Fetch and parse one listing page.
 *
 * The politeness gate runs here so the worker never has to think about robots
 * or budgets: robots -> rate limit -> HTTP, in that order. Checking robots
 * first means a disallowed URL does not consume the request budget.
 */
export const fetchListing = async (listingPath, page = 1, conditional = {}) => {
  const config = getSourceConfig(SOURCE);
  const url = listingUrl(listingPath, page);

  if (!(await isAllowed(url))) throw new RobotsDeniedError(url);

  const waitMs = await acquire(SOURCE, config.rateLimit);
  if (waitMs > 0) throw new RateLimitedError(waitMs);

  const delay = await crawlDelayMs(url);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

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

export default { listingUrl, fetchListing, RateLimitedError, RobotsDeniedError };
