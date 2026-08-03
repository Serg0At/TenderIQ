import fs from 'fs';
import path from 'path';
import https from 'https';
import tls from 'tls';
import axios from 'axios';
import iconv from 'iconv-lite';
import config from '../configs/variables.config.js';
import { logger } from './logger.js';

const { SCRAPER } = config;

/**
 * gnumner.minfin.am presents a valid leaf certificate but omits the
 * "GoGetSSL RSA DV SSL CA 2" intermediate, so Node cannot build a chain to a
 * trusted root and fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE (plain curl fails
 * the same way).
 *
 * The fix is to supply the missing intermediate, NOT to set
 * `rejectUnauthorized: false` — that would make the scraper accept any
 * certificate for these hosts, turning a chain-completeness problem into a
 * man-in-the-middle hole. Source content is untrusted *as data*; that is no
 * reason to stop authenticating who we are talking to.
 *
 * Refresh with:
 *   curl -s http://crt.sectigo.com/GoGetSSLRSADVSSLCA2.crt \
 *     | openssl x509 -inform DER -out certs/gogetssl-rsa-dv-ca2.pem
 */
const loadExtraCAs = () => {
  const dir = path.resolve(SCRAPER.EXTRA_CA_DIR);
  if (!fs.existsSync(dir)) return [];

  const pems = fs
    .readdirSync(dir)
    .filter((file) => /\.(pem|crt|cer)$/i.test(file))
    .map((file) => fs.readFileSync(path.join(dir, file), 'utf8'));

  if (pems.length) logger.info(`[http] trusting ${pems.length} extra CA cert(s) from ${dir}`);
  else logger.warn(`[http] ${dir} holds no PEM files — TLS to gnumner.minfin.am will fail`);

  return pems;
};

const extraCAs = loadExtraCAs();

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 8,
  // System roots are kept; the extras only fill chain gaps.
  ca: extraCAs.length ? [...tls.rootCertificates, ...extraCAs] : undefined,
});

/**
 * Decode bytes using the charset the server declared. Armenian government sites
 * still serve legacy encodings in places, and a mis-declared page should degrade
 * to mojibake in one field rather than throw mid-parse.
 */
const decode = (buffer, contentType) => {
  const match = /charset=["']?([\w-]+)/i.exec(contentType || '');
  const charset = (match ? match[1] : 'utf-8').toLowerCase();

  if (charset === 'utf-8' || charset === 'utf8') return buffer.toString('utf8');
  if (!iconv.encodingExists(charset)) {
    logger.warn(`[http] unknown charset "${charset}" — falling back to utf-8`);
    return buffer.toString('utf8');
  }
  return iconv.decode(buffer, charset);
};

const client = axios.create({
  timeout: SCRAPER.HTTP_TIMEOUT_MS,
  httpsAgent: agent,
  // Bytes, not a string: axios would otherwise guess the encoding for us.
  responseType: 'arraybuffer',
  maxRedirects: 5,
  decompress: true,
  headers: {
    'User-Agent': SCRAPER.USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'hy,en;q=0.8',
  },
  // 304 is the *success* case for a conditional GET; axios throws on it by default.
  validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
});

/**
 * Conditional GET. Pass the etag/lastModified stored from the previous fetch and
 * an unchanged page costs one round trip and zero parsing — which is what makes
 * a 5-minute cron over 28 pages affordable.
 *
 * @returns {{ status, notModified, body, raw, contentType, etag, lastModified }}
 */
export const fetchPage = async (url, { etag, lastModified } = {}) => {
  const headers = {};
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;

  const response = await client.get(url, { headers });

  if (response.status === 304) {
    return { status: 304, notModified: true, body: null, raw: null, etag, lastModified };
  }

  const buffer = Buffer.from(response.data);
  const contentType = response.headers['content-type'];

  return {
    status: response.status,
    notModified: false,
    body: decode(buffer, contentType),
    raw: buffer,
    contentType,
    etag: response.headers.etag,
    lastModified: response.headers['last-modified'],
  };
};

/**
 * Worth another attempt, or straight to the dead-letter queue?
 *
 * Retrying a 404 or a TLS failure five times just delays the alert by ten
 * minutes and hides the real cause, so only transient conditions qualify.
 */
export const isRetryable = (error) => {
  if (error.response) return error.response.status >= 500 || error.response.status === 429;
  return ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(
    error.code
  );
};

export default { fetchPage, isRetryable };
