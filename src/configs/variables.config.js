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

/**
 * An integer, optionally range-checked. The bounds are opt-in so every existing
 * caller keeps exactly the behaviour it had.
 */
const int = (key, fallback, { min = -Infinity, max = Infinity } = {}) => {
  const raw = optional(key, undefined);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`[config] ${key} must be an integer, received "${raw}"`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`[config] ${key} must be between ${min} and ${max}, received ${parsed}`);
  }
  return parsed;
};

/**
 * A ratio in [0,1]. Range-checked here rather than at the use site: a
 * confidence threshold of 75 instead of 0.75 would flag nothing for review and
 * fail completely silently, which is the worst way for a safety gate to break.
 */
const float = (key, fallback, { min = 0, max = 1 } = {}) => {
  const raw = optional(key, undefined);
  if (raw === undefined) return fallback;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`[config] ${key} must be a number, received "${raw}"`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`[config] ${key} must be between ${min} and ${max}, received ${parsed}`);
  }
  return parsed;
};

/**
 * A comma-separated list of integers, sorted descending.
 *
 * Sorted here rather than at the use site because the expiry sweep walks
 * thresholds widest-first and relies on that order to fire the 30-day warning
 * before the 7-day one; a config written "1,7,30" would otherwise silently
 * invert the sequence.
 */
const intList = (key, fallback) => {
  const raw = optional(key, undefined);
  if (raw === undefined) return fallback;
  const parsed = String(raw)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const value = Number.parseInt(part, 10);
      if (Number.isNaN(value) || value < 0) {
        throw new Error(`[config] ${key} must be a comma-separated list of non-negative integers, received "${raw}"`);
      }
      return value;
    });
  if (!parsed.length) throw new Error(`[config] ${key} must not be empty`);
  return [...new Set(parsed)].sort((a, b) => b - a);
};

/**
 * A comma-separated list of origins, normalised for comparison against a
 * browser's `Origin` header: lower-cased and stripped of any trailing slash,
 * because `http://localhost:3000/` in an env file and `http://localhost:3000`
 * on the wire are the same origin and a literal string match would say
 * otherwise. Deduped, order irrelevant.
 */
const originList = (key, fallback) => {
  const raw = optional(key, undefined);
  if (raw === undefined) return fallback;
  const parsed = String(raw)
    .split(',')
    .map((part) => part.trim().toLowerCase().replace(/\/+$/, ''))
    .filter(Boolean);
  return [...new Set(parsed)];
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

  /**
   * Browser access control. `CORS_ORIGIN` is a comma-separated allowlist; the
   * name matches the `cors` option it feeds, and it is the one spelling — an
   * env file that said `CORS` while the code read `CORS_ORIGIN` silently fell
   * through to a wildcard for the whole of this project's life.
   *
   * There is deliberately no wildcard here. `origin: '*'` alongside
   * `credentials: true` is a combination browsers reject outright for any
   * credentialed request, so it reads as permissive while actually being
   * broken; reflecting whatever origin asks would be worse, since it hands
   * every site on the internet the ability to make credentialed calls.
   *
   * An empty list therefore means "no cross-origin browser access", not
   * "all". That is fail-closed and costs nothing to the clients that do not
   * send an `Origin` header at all — curl, server-to-server, same-origin — as
   * CORS never applies to them. Outside production an empty list reflects the
   * caller instead, so a dev frontend on any localhost port just works.
   */
  CORS: {
    ORIGINS: originList('CORS_ORIGIN', []),
  },

  PSQL: {
    PORT: int('PSQL_PORT', 5432),
    HOST: optional('PSQL_HOST', 'localhost'),
    USER: optional('PSQL_USER', 'postgres'),
    DATABASE: optional('PSQL_DATABASE', 'Tendra'),
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

    /**
     * How long an email-verification link stays good. Generous, because the
     * cost of expiry is a support ticket from someone who read their mail the
     * next morning, and the token grants only "this address is real".
     */
    EMAIL_VERIFY_TTL_HOURS: int('AUTH_EMAIL_VERIFY_TTL_HOURS', 24),
    /**
     * A password-reset code is a different weight entirely: it grants the
     * account. Short-lived, and paired with an attempt ceiling — six digits is
     * a million guesses, which is nothing at machine speed if the code simply
     * sits there until it expires.
     */
    RESET_CODE_TTL_MINUTES: int('AUTH_RESET_CODE_TTL_MINUTES', 15),
    RESET_CODE_MAX_ATTEMPTS: int('AUTH_RESET_CODE_MAX_ATTEMPTS', 5),
  },

  /**
   * Outbound email — verification links and password-reset codes.
   *
   * DRIVER follows the STORAGE.DRIVER pattern, and defaults to `log` for the
   * same reason TELEGRAM defaults to polling: the API has to boot and the flows
   * have to be exercisable on a machine with no mail credentials. The `log`
   * driver writes the message, code and all, to the logger — which makes it
   * strictly a development setting, and why production must set `smtp`.
   */
  EMAIL: {
    DRIVER: oneOf('EMAIL_DRIVER', ['smtp', 'log'], 'log'),
    /** RFC 5322 From. A display name matters here: bare no-reply@ addresses score badly with spam filters. */
    FROM: optional('EMAIL_FROM', 'Tendra <no-reply@Tendra.am>'),
    /** Where a reply actually goes, if anywhere. Unset means the From address. */
    REPLY_TO: optional('EMAIL_REPLY_TO', undefined),
    SMTP: {
      HOST: optional('SMTP_HOST', undefined),
      PORT: int('SMTP_PORT', 587),
      /**
       * True only for implicit TLS on 465. On 587 this must stay false and the
       * connection is upgraded with STARTTLS, which the driver *requires* rather
       * than merely offers — an opportunistic upgrade silently sends the
       * credentials in clear if the server declines it.
       */
      SECURE: bool('SMTP_SECURE', false),
      USER: optional('SMTP_USER', undefined),
      PASSWORD: optional('SMTP_PASSWORD', undefined),
    },
    /**
     * Consecutive send failures before an email destination is auto-revoked.
     *
     * Higher than Telegram's, and deliberately so: Telegram reports a blocked
     * bot as an unambiguous 403 and that revokes on the first try, so this
     * counter only ever sees genuine trouble. Email has no such signal — a dead
     * mailbox and a misconfigured relay both arrive as a 5xx — so the counter is
     * the only thing separating them, and it needs enough attempts that a short
     * provider outage does not unsubscribe a customer.
     */
    MAX_FAILURES: int('EMAIL_MAX_FAILURES', 10),
  },

  STORAGE: {
    DRIVER: optional('STORAGE_DRIVER', 's3'), // s3 | local
    ENDPOINT: optional('S3_ENDPOINT', undefined),
    REGION: optional('S3_REGION', 'us-east-1'),
    BUCKET: optional('S3_BUCKET', 'Tendra'),
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
      'TendraBot/1.0 (+https://Tendra.am/bot; contact@Tendra.am)'
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
   * Subscriptions (ADR 0005). Card payments do not exist yet, so this holds only
   * what the trial needs.
   */
  BILLING: {
    /**
     * How long a trial lasts, in days, from the moment the owner starts it.
     * Bounded because nothing else checks it: 0 would be refused by the
     * period CHECK only when an owner pressed the button, and a stray extra
     * digit would hand out a free year.
     */
    TRIAL_DAYS: int('BILLING_TRIAL_DAYS', 30, { min: 1, max: 365 }),
  },

  /**
   * Relevance ranking.
   *
   * History never expires; it weighs less with age, in steps so a ranking can be
   * reproduced by hand: full weight inside FULL_WEIGHT_MONTHS, half to three
   * times that, a quarter beyond. One number because the backtest sweeps it —
   * suppliers here bid rarely (the median one, once in two months), so a short
   * window starves the signal rather than sharpening it.
   *
   * 24, not 12: public buyers here procure on a yearly budget, so the same
   * buyer tends to tender the same supplies once a year. At 12 months a bid on
   * last year's round fell to half weight exactly as this year's round opened —
   * the one tender it is most evidence for. 24 keeps the last two yearly rounds
   * at full weight. Chosen by that reasoning, not measured: two months of
   * ledger cannot separate windows; the backtest re-checks it once the archive
   * is loaded.
   */
  RELEVANCE: {
    FULL_WEIGHT_MONTHS: int('RELEVANCE_FULL_WEIGHT_MONTHS', 24),
  },

  /**
   * Inferred CPV codes (cpv-inference ticket 04, ADR 0006): how a lot whose
   * source states no code is coded at ingest.
   *
   *   nearest — the code of the most similar stated-code lot, no model call
   *             (`cpvInference.service.js#nearest`); the backtest's baseline.
   *   model   — a cheap model picks among the candidates (ticket 03).
   *
   * `nearest` by default: it costs nothing and needs no API key, and which
   * method earns its place is the backtest's call (ticket 06). A changed method
   * re-codes nothing already coded — only a deliberate script would.
   */
  CPV_INFERENCE: {
    METHOD: oneOf('CPV_INFERENCE_METHOD', ['nearest', 'model'], 'nearest'),
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
    /**
     * Where THIS API answers from, on the public internet — the origin only,
     * no path.
     *
     * Separate from `BASE_URL` because they are different machines and, right
     * now, different states of existence: there is no frontend, but the API is
     * deployed and reachable. The unsubscribe link in an alert email has to
     * survive that gap, so it points here rather than at a product page that
     * does not exist yet. A mail client's "Unsubscribe" button is worthless if
     * it opens a dead host.
     *
     * Unset means alert mail carries no unsubscribe link at all — the honest
     * degradation, and the same rule `BASE_URL` follows.
     */
    API_BASE_URL: optional('API_BASE_URL', undefined),
  },

  /**
   * The document vault — an organisation's reusable certificates and licences.
   *
   * Uploads never pass through this process: the API mints a presigned PUT and
   * the client sends the bytes straight to object storage, which is why
   * `express.json` stays at 1 MB while a scanned certificate may be 20.
   */
  VAULT: {
    /**
     * Upper bound on one document, enforced at registration against the size the
     * client declares AND on confirm against the size storage actually reports —
     * a declared size is a hint, and the second check is the one that holds.
     */
    MAX_UPLOAD_BYTES: int('VAULT_MAX_UPLOAD_BYTES', 20 * 1024 * 1024),
    /** How long a presigned PUT stays valid. Long enough for a slow upload, short enough that a leaked URL expires. */
    UPLOAD_URL_TTL_SECONDS: int('VAULT_UPLOAD_URL_TTL_SECONDS', 900),
    /** Download links are shorter-lived: they are handed out on every list view, not once per upload. */
    DOWNLOAD_URL_TTL_SECONDS: int('VAULT_DOWNLOAD_URL_TTL_SECONDS', 300),
    /**
     * Days before expiry at which a document earns an alert.
     *
     * Three thresholds, not one: 30 days is "start the renewal", 7 is "chase
     * it", 1 is "you are about to be disqualified". Each is its own notification
     * type, so the existing dedupe fires each exactly once without a per-document
     * state column — the same trick the deadline reminders use.
     */
    EXPIRY_WARN_DAYS: intList('VAULT_EXPIRY_WARN_DAYS', [30, 7, 1]),
    /**
     * How long a registered-but-unconfirmed upload survives before the sweep
     * prunes it. Comfortably longer than the presigned URL's own life, so a slow
     * client is never cleaned up mid-upload.
     */
    PENDING_TTL_HOURS: int('VAULT_PENDING_TTL_HOURS', 24),
  },

  AI: {
    API_KEY: optional('ANTHROPIC_API_KEY', undefined),
    /**
     * Override the API host.
     *
     * Unset means Anthropic direct. Set, it points the SDK at a gateway that
     * speaks the Messages API — OpenRouter (`https://openrouter.ai/api/v1`) is
     * the tested one. This is a base-URL swap, NOT a protocol change: the
     * gateway must accept `POST {BASE_URL}/messages` in native Anthropic shape,
     * including `output_config.format` json_schema, or the extractor loses the
     * schema-constrained output its safety design rests on.
     *
     * Verified against OpenRouter on 2026-08-26: `/v1/messages` returns a
     * native Anthropic response, `output_config.format` is honoured, and
     * `thinking: {type:'adaptive'}` and `cache_control` are accepted.
     *
     * A gateway also renames models — set AI_MODEL to match (OpenRouter wants
     * `anthropic/claude-opus-5`, not `claude-opus-5`).
     */
    BASE_URL: optional('ANTHROPIC_BASE_URL', undefined),
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
    /**
     * Below this, an extracted checklist item is flagged for human review
     * rather than presented as fact.
     *
     * The threshold is a product decision, not a model detail: everything the
     * extractor produces is advisory, and this is the line between "we found
     * this" and "check this yourself". Set it high — a false confident item is
     * worse than a flagged one, because a supplier acts on the first and reads
     * the second.
     */
    CHECKLIST_MIN_CONFIDENCE: float('AI_CHECKLIST_MIN_CONFIDENCE', 0.75),
    /**
     * Refuse a document larger than this rather than truncating it.
     *
     * Truncation is the tempting failure here and the wrong one: bid
     * requirements cluster at the END of an invitation, so a cut-off document
     * silently drops exactly what the checklist exists to find, and the result
     * looks complete. Opus 5 has a 1M-token context and the largest invitations
     * are far below it, so hitting this means something is wrong with the
     * document, not with the budget.
     */
    CHECKLIST_MAX_INPUT_CHARS: int('AI_CHECKLIST_MAX_INPUT_CHARS', 600000),
    /** Output ceiling for an extraction — a long checklist with evidence quotes. */
    CHECKLIST_MAX_TOKENS: int('AI_CHECKLIST_MAX_TOKENS', 16000),
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
export { required, optional, int, intList, originList, bool, oneOf };