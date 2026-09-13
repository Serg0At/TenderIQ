import crypto from 'node:crypto';
import config from '../../configs/variables.config.js';
import redis from '../../libs/redis.js';

const { AUTH } = config;

/**
 * The Redis half of authentication: refresh-token families, email-verification
 * tokens and password-reset codes.
 *
 * Separated from `auth.service.js` so the service reads as a sequence of
 * decisions rather than a sequence of key names, and so every credential this
 * system hands out has its lifetime described in one file.
 *
 * One rule holds across all three: **Redis never holds a usable secret.** Tokens
 * are stored under a hash of themselves and codes under an HMAC, so a dump of
 * this database yields nothing that can be presented back to the API. Only the
 * copy in the user's inbox is live.
 */

/** '20d' | '15m' | '30s' -> seconds, for aligning a Redis TTL with a token's expiry. */
export const toSeconds = (span) => {
  const m = /^(\d+)([smhd])$/.exec(String(span).trim());
  if (!m) return 900;
  const n = Number(m[1]);
  return n * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
};

const REFRESH_TTL = toSeconds(AUTH.REFRESH_TOKEN_ACTIVE_TIME);
const VERIFY_TTL = AUTH.EMAIL_VERIFY_TTL_HOURS * 3600;
const RESET_TTL = AUTH.RESET_CODE_TTL_MINUTES * 60;

/** Lookup key for a bearer-style secret: the secret itself never lands in Redis. */
const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/**
 * Keyed digest for the six-digit reset code.
 *
 * A plain SHA-256 would be pointless here — a million candidates is a
 * millisecond of work — so the code is bound to the app secret and to the
 * address it was issued for. The second half matters: without it, one leaked
 * digest could be replayed against any account whose code happened to match.
 */
const codeDigest = (email, code) =>
  crypto
    .createHmac('sha256', AUTH.JWT_ACCESS_SECRET ?? '')
    .update(`${String(email).toLowerCase()}:${code}`)
    .digest('hex');

/** Compare two hex digests without leaking, through timing, how far they matched. */
const digestsMatch = (a, b) => {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
};

/** 32 bytes, URL-safe: this goes in a link and must survive a mail client. */
export const randomToken = () => crypto.randomBytes(32).toString('base64url');

/**
 * A six-digit reset code, drawn from the CSPRNG rather than Math.random.
 *
 * `randomInt` is rejection-sampled, so the digits are uniform — a modulo of a
 * random byte stream is not, and a code space with a bias is a code space that
 * is smaller than it looks.
 */
export const randomCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

// ---------------------------------------------------------------------------
// Refresh-token families
// ---------------------------------------------------------------------------

/**
 * Refresh tokens are tracked by id, grouped into a "family" that survives
 * rotation.
 *
 * Access tokens are stateless and short-lived, so they cannot be revoked —
 * which is exactly why the long-lived half must be. Storing the id (not the
 * token) means a Redis dump leaks nothing usable.
 */
const familyKey = (family) => `refresh:family:${family}`;
const tokenKey = (jti) => `refresh:token:${jti}`;
/**
 * Every family a user currently holds.
 *
 * Needed because a password reset has to revoke *all* of a user's sessions and
 * knows only the user id — without this index there is no path from a user to
 * their families, and "sign everyone out" would mean scanning the keyspace.
 */
const userFamiliesKey = (userId) => `refresh:user:${userId}`;
/**
 * The families a user holds in ONE organization.
 *
 * The user index alone cannot end one tenant's sessions: `revokeAllForUser`
 * would sign a consultant out of every client because one of them removed
 * them. Removal and leaving need exactly the families minted for that
 * organization, and nothing else. An orgless family is in no organization and
 * is not indexed here.
 */
const userOrgFamiliesKey = (userId, organizationId) => `refresh:user:${userId}:${organizationId}`;

export const rememberRefresh = async (family, jti, userId, organizationId = null) => {
  const client = redis.getRedis();
  await client.set(tokenKey(jti), family, 'EX', REFRESH_TTL);
  await client.sadd(familyKey(family), jti);
  await client.expire(familyKey(family), REFRESH_TTL);

  if (userId) {
    await client.sadd(userFamiliesKey(userId), family);
    // Refreshed on every rotation, so an active session's index never expires
    // out from under it while the family itself is still alive.
    await client.expire(userFamiliesKey(userId), REFRESH_TTL);

    if (organizationId) {
      await client.sadd(userOrgFamiliesKey(userId, organizationId), family);
      await client.expire(userOrgFamiliesKey(userId, organizationId), REFRESH_TTL);
    }
  }
};

export const familyOf = async (jti) => redis.getRedis().get(tokenKey(jti));

/** Consume one presented refresh token before its replacement is minted. */
export const consumeRefresh = async (family, jti) => {
  const client = redis.getRedis();
  await client.del(tokenKey(jti));
  await client.srem(familyKey(family), jti);
};

/** Logout, password change, or detected theft — all revoke the whole family. */
export const revokeFamily = async (family, userId = null, organizationId = null) => {
  const client = redis.getRedis();
  const members = await client.smembers(familyKey(family));
  if (members.length) await client.del(...members.map(tokenKey));
  await client.del(familyKey(family));
  if (userId) await client.srem(userFamiliesKey(userId), family);
  if (userId && organizationId) await client.srem(userOrgFamiliesKey(userId, organizationId), family);
};

/**
 * Every session this user holds in one organization, gone — and only those.
 *
 * What ending a membership calls. Be honest about what it buys: `refresh()`
 * already fails closed once the membership is gone, so this is Redis hygiene
 * and the belt to that query's suspenders. It does not shorten anything — a
 * stateless access token cannot be recalled, and a removed member keeps it
 * until it expires either way.
 */
export const revokeForOrganization = async (userId, organizationId) => {
  const client = redis.getRedis();
  const families = await client.smembers(userOrgFamiliesKey(userId, organizationId));
  for (const family of families) await revokeFamily(family, userId);
  await client.del(userOrgFamiliesKey(userId, organizationId));
  return families.length;
};

/**
 * Every session this user has, gone.
 *
 * The password-reset path's other half: changing a password while the old
 * sessions keep working is a reset that fails to lock out whoever caused it.
 */
export const revokeAllForUser = async (userId) => {
  const client = redis.getRedis();
  const families = await client.smembers(userFamiliesKey(userId));
  for (const family of families) await revokeFamily(family);
  await client.del(userFamiliesKey(userId));
  return families.length;
};

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

const verifyKey = (token) => `auth:verify:${digest(token)}`;
/** Points at the live token's key, so issuing a new one retires the last. */
const verifyOwnerKey = (userId) => `auth:verify:user:${userId}`;

/**
 * Issue a verification token, superseding any outstanding one.
 *
 * Superseding matters: a user who clicks "resend" three times should end up
 * with one working link, not three. Leaving the old ones live would widen the
 * window on a token that may have been sent to a mistyped address.
 */
export const issueVerificationToken = async ({ userId, email }) => {
  const client = redis.getRedis();
  const previous = await client.get(verifyOwnerKey(userId));
  if (previous) await client.del(previous);

  const token = randomToken();
  const key = verifyKey(token);
  await client.set(key, JSON.stringify({ userId, email }), 'EX', VERIFY_TTL);
  await client.set(verifyOwnerKey(userId), key, 'EX', VERIFY_TTL);
  return token;
};

export const readVerificationToken = async (token) => {
  const raw = await redis.getRedis().get(verifyKey(token));
  return raw ? JSON.parse(raw) : null;
};

/**
 * Retire a token, only after the database has recorded the verification.
 *
 * Read → write → delete, in that order and never the other way round: if the
 * update fails, the token is still there and the user's second click works.
 * A GETDEL would hand back the only copy and lose it on any error after.
 */
export const consumeVerificationToken = async (token, userId) => {
  const client = redis.getRedis();
  await client.del(verifyKey(token));
  if (userId) await client.del(verifyOwnerKey(userId));
};

// ---------------------------------------------------------------------------
// Password reset codes
// ---------------------------------------------------------------------------

const resetKey = (email) => `auth:reset:${digest(String(email).toLowerCase())}`;

/**
 * A Redis hash rather than a JSON string, so the attempt counter can be
 * incremented atomically. Read-modify-write on a JSON blob would let two
 * concurrent guesses both read `attempts: 4` and both be allowed through.
 */
export const issueResetCode = async ({ email, userId }) => {
  const client = redis.getRedis();
  const code = randomCode();
  const key = resetKey(email);

  await client.del(key);
  await client.hset(key, {
    code_hash: codeDigest(email, code),
    user_id: userId,
    attempts: 0,
  });
  await client.expire(key, RESET_TTL);
  return code;
};

/**
 * Check a code, counting the failures.
 *
 * Returns one of:
 *   { ok: true, userId }
 *   { ok: false, reason: 'expired' }   — nothing outstanding, or the TTL passed
 *   { ok: false, reason: 'mismatch' }  — wrong code, attempts remain
 *   { ok: false, reason: 'locked' }    — wrong code, and that was the last try
 *
 * The ceiling is the point. Six digits is a million possibilities, which sounds
 * like a lot and is roughly a minute of scripted guessing; a code that simply
 * waits out its TTL under unlimited attempts is not a second factor, it is a
 * short delay. Burning the code on the last failure means the attacker's cost
 * is a new email to the victim's inbox — visible, and rate-limited.
 *
 * `consume` is false for the check-only endpoint and true when the code is
 * actually being spent on a new password.
 */
export const verifyResetCode = async ({ email, code, consume = false }) => {
  const client = redis.getRedis();
  const key = resetKey(email);
  const stored = await client.hgetall(key);

  if (!stored || !stored.code_hash) return { ok: false, reason: 'expired' };

  if (digestsMatch(stored.code_hash, codeDigest(email, code))) {
    if (consume) await client.del(key);
    return { ok: true, userId: stored.user_id };
  }

  const attempts = await client.hincrby(key, 'attempts', 1);
  if (attempts >= AUTH.RESET_CODE_MAX_ATTEMPTS) {
    await client.del(key);
    return { ok: false, reason: 'locked' };
  }
  return { ok: false, reason: 'mismatch' };
};

export const clearResetCode = async (email) => redis.getRedis().del(resetKey(email));

export default {
  toSeconds,
  randomToken,
  randomCode,
  rememberRefresh,
  familyOf,
  consumeRefresh,
  revokeFamily,
  revokeForOrganization,
  revokeAllForUser,
  issueVerificationToken,
  readVerificationToken,
  consumeVerificationToken,
  issueResetCode,
  verifyResetCode,
  clearResetCode,
};
