import 'dotenv/config';

const required = (key) => {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(`[config] Missing required environment variable: ${key}`);
  }
  return value;
};

const optional = (key, fallback) => {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
};

const int = (key, fallback) => {
  const raw = optional(key, undefined);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`[config] ${key} must be an integer, received "${raw}"`);
  }
  return parsed;
};

const bool = (key, fallback) => {
  const raw = optional(key, undefined);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
};

/**
 * PSQL_SSL accepts a plain boolean *or* standard Postgres sslmode vocabulary
 * ('require', 'prefer', 'verify-ca', 'verify-full'), because that is what Neon,
 * RDS and every psql connection string already use. Parsing it with the generic
 * bool() silently disabled TLS against a provider that mandates it.
 */
const sslFlag = (key, fallback) => {
  const raw = optional(key, undefined);
  if (raw === undefined) return fallback;
  const value = String(raw).toLowerCase();
  if (['disable', 'false', '0', 'no', 'off'].includes(value)) return false;
  return ['1', 'true', 'yes', 'on', 'require', 'prefer', 'verify-ca', 'verify-full'].includes(
    value
  );
};

const config = {
  NODE_ENV: optional('NODE_ENV', 'development'),
  PORT: int('PORT', 5000),
  LOG_LEVEL: optional('LOG_LEVEL', 'info'),

  ADMIN_PASSWORD: optional('ADMIN_PASSWORD', undefined),

  PSQL: {
    PORT: int('PSQL_PORT', 5432),
    HOST: optional('PSQL_HOST', 'localhost'),
    USER: optional('PSQL_USER', 'postgres'),
    DATABASE: optional('PSQL_DATABASE', 'tenderiq'),
    PASSWORD: optional('PSQL_PASSWORD', ''),
    SSL: sslFlag('PSQL_SSL', true),
  },

  REDIS: {
    HOST: optional('REDIS_HOST', 'localhost'),
    PORT: int('REDIS_PORT', 6379),
    PASSWORD: optional('REDIS_PASSWORD', undefined),
    DB: int('REDIS_DB', 0),
    TLS: bool('REDIS_TLS', false),
  },

  AUTH: {
    JWT_ACCESS_SECRET: optional('JWT_ACCESS_SECRET', undefined),
    JWT_REFRESH_SECRET: optional('JWT_REFRESH_SECRET', undefined),
    REFRESH_TOKEN_ACTIVE_TIME: optional('REFRESH_TOKEN_ACTIVE_TIME', '20d'),
    ACCESS_TOKEN_ACTIVE_TIME: optional('ACCESS_TOKEN_ACTIVE_TIME', '15m'),
  },

  GOOGLE_OAUTH: {
    CLIENT_ID: optional('GOOGLE_CLIENT_ID', undefined),
    CLIENT_SECRET: optional('GOOGLE_CLIENT_SECRET', undefined),
    CALLBACK_URL: optional('CALLBACK_URL', undefined),
  },

  STORAGE: {
    DRIVER: optional('STORAGE_DRIVER', 's3'), // s3 | local
    ENDPOINT: optional('S3_ENDPOINT', undefined),
    REGION: optional('S3_REGION', 'us-east-1'),
    BUCKET: optional('S3_BUCKET', 'tenderiq'),
    ACCESS_KEY: optional('S3_ACCESS_KEY', undefined),
    SECRET_KEY: optional('S3_SECRET_KEY', undefined),
    FORCE_PATH_STYLE: bool('S3_FORCE_PATH_STYLE', true),
    /** 'AES256' | 'aws:kms' | 'none'. MinIO needs 'none' unless KMS is set up. */
    SSE: optional('S3_SSE', 'AES256'),
    LOCAL_ROOT: optional('STORAGE_LOCAL_ROOT', './.storage'),
  },

  SCRAPER: {
    USER_AGENT: optional(
      'SCRAPER_USER_AGENT',
      'TenderIQBot/1.0 (+https://tenderiq.am/bot; contact@tenderiq.am)'
    ),
    /**
     * PEMs here are added to the TLS trust store alongside the system roots.
     *
     * Do not delete this or `certs/` as dead weight. `gnumner.minfin.am` omits
     * its intermediate certificate, so without the bundled CA Node cannot build
     * a chain and every request to it fails — verified 2026-08-16:
     *
     *   eauction.armeps.am -> 302 OK with system roots alone
     *   gnumner.minfin.am  -> UNABLE_TO_VERIFY_LEAF_SIGNATURE
     *
     * No *configured* source needs it today — eauction serves a valid chain.
     * It stays because anything on gnumner still does: the official CPV
     * dictionary at /website/images/original/, and the notice board if it is
     * ever added as a source for non-e-auction procedures.
     *
     * Never "fix" a chain failure with rejectUnauthorized: false.
     */
    EXTRA_CA_DIR: optional('SCRAPER_EXTRA_CA_DIR', './certs'),
    HTTP_TIMEOUT_MS: int('SCRAPER_HTTP_TIMEOUT_MS', 30000),
    BROWSER_TIMEOUT_MS: int('SCRAPER_BROWSER_TIMEOUT_MS', 60000),
    MAX_ATTEMPTS: int('SCRAPER_MAX_ATTEMPTS', 5),
    BACKOFF_BASE_MS: int('SCRAPER_BACKOFF_BASE_MS', 2000),
    BACKOFF_MAX_MS: int('SCRAPER_BACKOFF_MAX_MS', 120000),
    MAX_LISTING_PAGES: int('SCRAPER_MAX_LISTING_PAGES', 200),
    MAX_DOCUMENT_BYTES: int('SCRAPER_MAX_DOCUMENT_BYTES', 60 * 1024 * 1024),
    FRESHNESS_SLA_MINUTES: int('SCRAPER_FRESHNESS_SLA_MINUTES', 15),
  },
};

export default config;
export { required, optional, int, bool };