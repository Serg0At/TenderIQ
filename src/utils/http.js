import fs from 'fs';
import path from 'path';
import https from 'https';
import tls from 'tls';
import axios from 'axios';
import iconv from 'iconv-lite';
import config from '../configs/variables.config.js';
import { logger } from './logger.js';

const { SCRAPER } = config;

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
  ca: extraCAs.length ? [...tls.rootCertificates, ...extraCAs] : undefined,
});

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

/**
 * Hard ceiling on any single response body.
 *
 * Enforced by axios itself, which counts bytes as they arrive and destroys the
 * stream on overflow — it does NOT need a Content-Length header, so a source
 * that omits one (this one does) is still covered. axios defaults both limits
 * to -1, i.e. unlimited, so without this an invitation link pointing at a
 * multi-gigabyte object would be buffered whole into the worker process, which
 * also runs ingest.fetch and ingest.normalize.
 */
export const MAX_DOCUMENT_BYTES = 60 * 1024 * 1024;

const client = axios.create({
  timeout: SCRAPER.HTTP_TIMEOUT_MS,
  httpsAgent: agent,
  responseType: 'arraybuffer',
  maxRedirects: 5,
  decompress: true,
  maxContentLength: MAX_DOCUMENT_BYTES,
  maxBodyLength: MAX_DOCUMENT_BYTES,
  headers: {
    'User-Agent': SCRAPER.USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'hy,en;q=0.8',
  },
  // 304 is the *success* case for a conditional GET; axios throws on it by default.
  validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
});

export const fetchPage = async (url, { etag, lastModified, binary = false } = {}) => {
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
    // Binary payloads (invitation archives) skip decoding: running a 600 KB
    // ZIP through a utf-8 decoder produces a meaningless string and costs more
    // than the request did.
    body: binary ? null : decode(buffer, contentType),
    raw: buffer,
    contentType,
    etag: response.headers.etag,
    lastModified: response.headers['last-modified'],
  };
};


// Browser-rendered fetch removed — listing/detail parsers operate on
// server-returned HTML only.

export const isRetryable = (error) => {
  if (error.response) return error.response.status >= 500 || error.response.status === 429;
  return ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(
    error.code
  );
};

export default { fetchPage, isRetryable };
