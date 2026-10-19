import { getSourceConfig } from '../../../../configs/sources.config.js';
import { fetchPage } from '../../../../utils/http.js';
import { acquire, RateLimitedError } from '../../../../utils/rateLimiter.js';

/**
 * armeps.am, the e-PPS behind every ARMEPS tender. Both URLs are built here
 * from a `resourceId` and the configured base, never taken from a page, so
 * scraped content never chooses where the worker connects.
 *
 * No cookie is kept. Without a session the site serves the CfT page in
 * English, which is what the parser reads, and the anonymous download
 * ("Proceed without association") needs none either.
 */
const SOURCE = 'armeps';

/** The CfT's "Contract Documents" tab, the page gnumner links to. */
export const cftUrl = (resourceId) =>
  `${getSourceConfig(SOURCE).baseUrl}/epps/cft/listContractDocuments.do?resourceId=${encodeURIComponent(resourceId)}`;

/**
 * Every contract document as one ZIP — the page's "Download Zip file". The
 * popup in front of it (`prepareAnonymousDownload.do`) only asks whether to
 * log in first; this is the URL its "Proceed without association" opens.
 */
export const documentsUrl = (resourceId) =>
  `${getSourceConfig(SOURCE).baseUrl}/epps/cft/downloadCftResourceItems.do?resourceId=${encodeURIComponent(resourceId)}` +
  '&resourceType=ContractDocument';

const gate = async () => {
  const waitMs = await acquire(SOURCE, getSourceConfig(SOURCE).rateLimit);
  if (waitMs > 0) throw new RateLimitedError(SOURCE, waitMs);
};

/** Politeness gate, in order: rate limit, then HTTP. The site sends `no-store`, so no conditional GET. */
export const fetchCft = async (resourceId) => {
  const url = cftUrl(resourceId);
  await gate();
  return { url, response: await fetchPage(url) };
};

/** Same gate and the same budget as the page: one host, one allowance. */
export const fetchDocuments = async (resourceId) => {
  const url = documentsUrl(resourceId);
  await gate();
  const response = await fetchPage(url, { binary: true });
  return { url, bytes: response.raw, contentType: response.contentType };
};

export default { cftUrl, documentsUrl, fetchCft, fetchDocuments };
