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
 * An enum-valued variable, validated at boot.
 *
 * A typo'd mode is the kind of misconfiguration that surfaces hours later as
 * "alerts never arrive": an unrecognised value would silently take whichever
 * branch the code treats as the default. Refusing to boot is the rule the rest
 * of this file already follows.
 */
const oneOf = (key, allowed, fallback) => {
  const value = optional(key, fallback);
  if (!allowed.includes(value)) {
    throw new Error(`[config] ${key} must be one of ${allowed.join(' | ')}, received "${value}"`);
  }
  return value;
};

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

  /**
   * Price-intelligence tuning.
   *
   * The reference specification leaves the comparables threshold as a literal
   * `N` in every occurrence and never assigns it; the only bracketing evidence
   * is a worked example where sampleSize 7 succeeds and 1 returns
   * insufficient_data. 5 is the chosen starting point, kept configurable
   * because the spec lists "configurable comparables threshold per category"
   * as a future improvement.
   */
  INTELLIGENCE: {
    /** Below this many comparable awards, a benchmark refuses to report. */
    MIN_COMPARABLES: int('INTELLIGENCE_MIN_COMPARABLES', 5),
    /** How far back an award still counts as evidence of today's price. */
    RECENCY_MONTHS: int('INTELLIGENCE_RECENCY_MONTHS', 24),
  },

  /**
   * The AI layer. `API_KEY` is optional so the API and workers still boot
   * without it — the price-recommendation endpoint answers 503
   * DEPENDENCY_UNAVAILABLE instead, which is the honest failure for a feature
   * whose dependency is not configured. Every other feature is unaffected.
   */
  /**
   * Telegram — the first real delivery channel.
   *
   * Everything is optional so the API and workers boot without a bot token; the
   * channel then reports `failed` for every send, exactly as the placeholder
   * did, rather than taking the process down.
   *
   * MODE picks how inbound updates arrive, the same shape as STORAGE.DRIVER:
   *   polling  — a getUpdates loop in the worker. Needs no public URL, which is
   *              why it is the default: this project has no deployed HTTPS
   *              endpoint and a webhook cannot be registered without one.
   *   webhook  — Telegram POSTs to the API. Lower latency, no idle polling, but
   *              unusable locally without a tunnel.
   *   off      — outbound still works, inbound disabled. The honest setting for
   *              a second worker replica: polling must run in exactly one
   *              process or two consumers fight over the same update offset.
   */
  TELEGRAM: {
    BOT_TOKEN: optional('TELEGRAM_BOT_TOKEN', undefined),
    /** The bot's @name, needed to build the t.me deep link. */
    BOT_USERNAME: optional('TELEGRAM_BOT_USERNAME', undefined),
    MODE: oneOf('TELEGRAM_MODE', ['polling', 'webhook', 'off'], 'polling'),
    API_BASE: optional('TELEGRAM_API_BASE', 'https://api.telegram.org'),
    /**
     * Checked against Telegram's X-Telegram-Bot-Api-Secret-Token header. The
     * webhook route is necessarily unauthenticated — Telegram cannot present a
     * JWT — so this is the only thing between the handler and anyone who
     * guesses the URL.
     */
    WEBHOOK_SECRET: optional('TELEGRAM_WEBHOOK_SECRET', undefined),
    /** Long-poll hold. Telegram allows up to 50s; the HTTP timeout must exceed it. */
    POLL_TIMEOUT_SECONDS: int('TELEGRAM_POLL_TIMEOUT_SECONDS', 30),
    /** Link-token lifetime. Short, because the token grants alert delivery to a chat. */
    LINK_TOKEN_TTL_MINUTES: int('TELEGRAM_LINK_TOKEN_TTL_MINUTES', 30),
    /** Consecutive send failures before a subscription is auto-revoked. */
    MAX_FAILURES: int('TELEGRAM_MAX_FAILURES', 5),
  },

  /**
   * Where the product lives, for deep links in alerts. Unset falls back to the
   * source's own page, which is the honest link while there is no frontend — a
   * dead link into an app that does not exist is worse than none.
   */
  APP: {
    BASE_URL: optional('APP_BASE_URL', undefined),
  },

  AI: {
    API_KEY: optional('ANTHROPIC_API_KEY', undefined),
    /**
     * Current generation. The reference spec's `ai/Model Selection.md` names an
     * older one; its ROUTING logic still applies (cheap model for bulk
     * classification, stronger model for hard or ambiguous work) but its model
     * IDs are stale and must not be copied forward.
     */
    MODEL: optional('AI_MODEL', 'claude-opus-5'),
    MAX_TOKENS: int('AI_MAX_TOKENS', 4096),
    /**
     * How long a recommendation stays cached in Redis. Keyed by a hash of the
     * evidence, so the entry is invalidated by the evidence changing rather
     * than by the clock — this is a cost ceiling on repeat views of the same
     * unchanged tender, not a freshness policy.
     */
    CACHE_TTL_SECONDS: int('AI_CACHE_TTL_SECONDS', 24 * 60 * 60),
    /** Wall-clock ceiling for one call, so a hung request cannot pin a worker. */
    TIMEOUT_MS: int('AI_TIMEOUT_MS', 120000),
  },

  /**
   * Thresholds for the pipeline health check. These are alarm levels, not
   * targets: crossing one means a human should look, so they are set where a
   * healthy system never reaches them.
   */
  MONITOR: {
    CRON: optional('MONITOR_CRON', '*/5 * * * *'),
    /** Dead-lettered jobs across all queues before the check screams. */
    DLQ_ALERT: int('MONITOR_DLQ_ALERT', 10),
    /** Waiting depth that means a worker is down or wedged, not merely busy. */
    BACKLOG_ALERT: int('MONITOR_BACKLOG_ALERT', 5000),
  },
};

export default config;
export { required, optional, int, bool, oneOf };