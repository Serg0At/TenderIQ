import { getSourceConfig, hostOf } from '../../../../configs/sources.config.js';
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

/**
 * What the pure listing parser classifies links against, from the sources
 * config: relative hrefs resolve against gnumner's base, and an absolute one
 * is ARMEPS, e-auction or gnumner's own upload by its host.
 */
export const listingContext = () => ({
  baseUrl: getSourceConfig(SOURCE).baseUrl,
  hosts: { gnumner: hostOf(SOURCE), armeps: hostOf('armeps'), eauction: hostOf('eauction') },
});

/** Politeness gate, in order: rate limit, then HTTP. */
export const fetchListing = async (listingPath, page = 1) => {
  const config = getSourceConfig(SOURCE);
  const url = listingUrl(listingPath, page);

  const waitMs = await acquire(SOURCE, config.rateLimit);
  if (waitMs > 0) throw new RateLimitedError(SOURCE, waitMs);

  // No conditional GET: the site sends neither ETag nor Last-Modified.
  const response = await fetchPage(url);
  const { items, blocksSeen, skipped, hasNextPage } = parseListing(response.body, listingContext());

  return { url, items, blocksSeen, skipped, hasNextPage, response };
};

/**
 * An uploaded file's URL, built from the configured base and the path the
 * listing classified as gnumner's own upload — never taken whole from a page,
 * so scraped content never chooses where the worker connects. The path is
 * the URL's pathname, already percent-encoded.
 */
export const invitationUrl = (path) => {
  if (!String(path).startsWith('/website/images/')) {
    throw new Error(`[${SOURCE}] not an upload path: ${JSON.stringify(path)}`);
  }
  return `${getSourceConfig(SOURCE).baseUrl}${path}`;
};

/** One paper invitation's bytes. Same gate, same budget as the listing: one host, one allowance. */
export const fetchInvitation = async (path) => {
  const config = getSourceConfig(SOURCE);
  const url = invitationUrl(path);

  const waitMs = await acquire(SOURCE, config.rateLimit);
  if (waitMs > 0) throw new RateLimitedError(SOURCE, waitMs);

  const response = await fetchPage(url, { binary: true });
  return { url, bytes: response.raw, contentType: response.contentType };
};

export default { listingUrl, listingContext, fetchListing, invitationUrl, fetchInvitation };
