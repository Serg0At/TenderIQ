import { getSourceConfig } from '../../../../configs/sources.config.js';
import { fetchPage } from '../../../../utils/http.js';
import { acquire, RateLimitedError } from '../../../../utils/rateLimiter.js';
import { parseListing } from './listing.parser.js';

/**
 * gnumner.minfin.am omits its intermediate certificate. The shared HTTP agent
 * trusts `certs/` (SCRAPER.EXTRA_CA_DIR) for exactly this host; a chain
 * failure here is fixed there, never with `rejectUnauthorized: false`.
 */
const SOURCE = 'gnumner';

/**
 * Page 1 is the bare listing path; page N appends the bare number — verified
 * against the live pager, e.g. …/gnanshman_harcman_haytararutyun_ev_hraver/2.
 */
export const listingUrl = (listingPath, page = 1) => {
  const { baseUrl } = getSourceConfig(SOURCE);
  return page <= 1 ? `${baseUrl}${listingPath}` : `${baseUrl}${listingPath}${page}`;
};

/** Politeness gate, in order: rate limit, then HTTP. */
export const fetchListing = async (listingPath, page = 1) => {
  const config = getSourceConfig(SOURCE);
  const url = listingUrl(listingPath, page);

  const waitMs = await acquire(SOURCE, config.rateLimit);
  if (waitMs > 0) throw new RateLimitedError(SOURCE, waitMs);

  // No conditional GET: the site sends neither ETag nor Last-Modified.
  const response = await fetchPage(url);
  const { items, blocksSeen, skipped, hasNextPage } = parseListing(response.body);

  return { url, items, blocksSeen, skipped, hasNextPage, response };
};

export default { listingUrl, fetchListing };
