import robotsParser from 'robots-parser';
import config from '../configs/variables.config.js';
import redis from '../libs/redis.js';
import { logger } from './logger.js';
import { fetchPage } from './http.js';

const { SCRAPER } = config;
const CACHE_TTL_SECONDS = 24 * 60 * 60;

const cacheKey = (origin) => `robots:${origin}`;

/**
 * Fetch robots.txt once per host per day.
 *
 * gnumner.minfin.am has no robots.txt, but rather than a 404 status it serves an
 * HTML "404 - Page Not Found" page with a success-ish body. Handing that to
 * robots-parser would mean parsing an HTML template as crawl rules — and a
 * stray "Disallow" inside that template would silently stop all ingestion.
 * So anything that is not text/plain is treated as "no robots.txt" (= allowed).
 *
 * The empty result is cached too; otherwise a missing file is re-fetched on
 * every sweep, 288 times a day.
 */
const loadRobots = async (origin) => {
  const client = redis.getRedis();
  const cached = await client.get(cacheKey(origin));
  if (cached !== null) return cached;

  let body = '';
  try {
    const result = await fetchPage(`${origin}/robots.txt`);
    const isPlainText = (result.contentType || '').includes('text/plain');
    body = isPlainText ? result.body : '';
    if (!isPlainText) logger.info(`[robots] ${origin} serves no usable robots.txt — allowing`);
  } catch (error) {
    // An unreachable robots.txt is not permission to hammer the host, but it is
    // also not a reason to stall ingestion. Rate limits still apply either way.
    logger.warn(`[robots] ${origin} fetch failed (${error.message}) — allowing`);
  }

  await client.set(cacheKey(origin), body, 'EX', CACHE_TTL_SECONDS);
  return body;
};

export const isAllowed = async (url) => {
  if (!SCRAPER.RESPECT_ROBOTS) return true;

  const { origin } = new URL(url);
  const body = await loadRobots(origin);
  if (!body) return true;

  // isAllowed() returns undefined when no rule matches; only an explicit false
  // is a denial.
  return robotsParser(`${origin}/robots.txt`, body).isAllowed(url, SCRAPER.USER_AGENT) !== false;
};

/** Honour Crawl-delay when a host asks for one; 0 when it does not. */
export const crawlDelayMs = async (url) => {
  if (!SCRAPER.RESPECT_ROBOTS) return 0;

  const { origin } = new URL(url);
  const body = await loadRobots(origin);
  if (!body) return 0;

  const delay = robotsParser(`${origin}/robots.txt`, body).getCrawlDelay(SCRAPER.USER_AGENT);
  return delay ? delay * 1000 : 0;
};

export default { isAllowed, crawlDelayMs };
