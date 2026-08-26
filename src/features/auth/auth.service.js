import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createId } from '@paralleldrive/cuid2';
import config from '../../configs/variables.config.js';
import { withTransaction } from '../../libs/knex.js';
import redis from '../../libs/redis.js';
import users from '../../repositories/user.repo.js';
import organizations from '../../repositories/organization.repo.js';
import { ApiError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

const { AUTH } = config;
const BCRYPT_ROUNDS = 12;

/** '20d' | '15m' | '30s' -> seconds, for aligning Redis TTL with token expiry. */
const toSeconds = (span) => {
  const m = /^(\d+)([smhd])$/.exec(String(span).trim());
  if (!m) return 900;
  const n = Number(m[1]);
  return n * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
};

const REFRESH_TTL = toSeconds(AUTH.REFRESH_TOKEN_ACTIVE_TIME);

const requireSecrets = () => {
  if (!AUTH.JWT_ACCESS_SECRET || !AUTH.JWT_REFRESH_SECRET) {
    throw new ApiError('INTERNAL_ERROR', { message: 'Auth is not configured.' });
  }
};

/**
 * Refresh tokens are tracked in Redis by id, grouped into a "family" that
 * survives rotation.
 *
 * Access tokens are stateless and short-lived, so they cannot be revoked —
 * which is exactly why the long-lived half must be. Storing the id (not the
 * token) means a Redis dump leaks nothing usable.
 */
const familyKey = (family) => `refresh:family:${family}`;
const tokenKey = (jti) => `refresh:token:${jti}`;

const rememberRefresh = async (family, jti) => {
  const client = redis.getRedis();
  await client.set(tokenKey(jti), family, 'EX', REFRESH_TTL);
  await client.sadd(familyKey(family), jti);
  await client.expire(familyKey(family), REFRESH_TTL);
};

/** Logout, password change, or detected theft — all revoke the whole family. */
const revokeFamily = async (family) => {
  const client = redis.getRedis();
  const members = await client.smembers(familyKey(family));
  if (members.length) await client.del(...members.map(tokenKey));
  await client.del(familyKey(family));
};

const issueTokens = async ({ userId, organizationId, role, plan, family = createId() }) => {
  requireSecrets();
  const jti = createId();

  const accessToken = jwt.sign(
    { sub: userId, org: organizationId, role, plan },
    AUTH.JWT_ACCESS_SECRET,
    { expiresIn: AUTH.ACCESS_TOKEN_ACTIVE_TIME, jwtid: createId() }
  );

  const refreshToken = jwt.sign(
    { sub: userId, org: organizationId, family },
    AUTH.JWT_REFRESH_SECRET,
    { expiresIn: AUTH.REFRESH_TOKEN_ACTIVE_TIME, jwtid: jti }
  );

  await rememberRefresh(family, jti);
  return { accessToken, refreshToken, expiresIn: toSeconds(AUTH.ACCESS_TOKEN_ACTIVE_TIME) };
};

const sessionFor = async (user, organizationId = null) => {
  const membership = await organizations.findMembership(user.id, organizationId);
  if (!membership) throw ApiError.forbidden('ROLE_FORBIDDEN', { reason: 'no organization membership' });

  const plan = await organizations.planFor(membership.organization_id);
  const tokens = await issueTokens({
    userId: user.id,
    organizationId: membership.organization_id,
    role: membership.role,
    plan,
  });

  return {
    ...tokens,
    user: { id: user.id, email: user.email, locale: user.locale },
    organization: { id: membership.organization_id, name: membership.organization_name },
    role: membership.role,
    plan,
  };
};

export default class AuthService {
  /**
   * Register a user, their organization, and an owner membership atomically.
   *
   * One transaction because a user with no organization cannot log in — the
   * token needs a tenant — so a partial write would produce a permanently
   * broken account that looks successfully created.
   */
  static async register({ email, password, organizationName, locale }) {
    const existing = await users.findByEmail(email);
    if (existing) throw ApiError.conflict('That email is already registered.');

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const user = await withTransaction(async (trx) => {
      await organizations.ensureRoles(trx);
      const userId = await users.create({ email, passwordHash, locale }, trx);
      const organizationId = await organizations.createWithOwner(
        { name: organizationName, userId },
        trx
      );
      // The creator is the owner: someone must hold billing:manage, and an org
      // whose only member cannot manage it is unusable.
      await organizations.addMember({ userId, organizationId, roleName: 'owner' }, trx);
      return users.findById(userId, trx);
    });

    return sessionFor(user);
  }

  /**
   * Verify a password and start a session.
   *
   * Unknown email and wrong password return the identical error on purpose:
   * distinguishing them turns the endpoint into a register of who holds an
   * account here.
   */
  static async login({ email, password }) {
    const user = await users.findByEmail(email);
    const hash = user?.password_hash ?? '';
    const valid = await bcrypt.compare(password, hash).catch(() => false);

    if (!user || !valid) throw ApiError.unauthenticated('Email or password is incorrect.');
    return sessionFor(user);
  }

  /**
   * Rotate a refresh token, detecting reuse.
   *
   * Each refresh token is single-use. Presenting one that verifies but is no
   * longer tracked means it was already exchanged — either a replay or a
   * stolen copy racing the legitimate holder. Since the two are
   * indistinguishable, the whole family is revoked and everyone re-logs in:
   * the safe reading of an ambiguous signal.
   */
  static async refresh({ refreshToken }) {
    requireSecrets();

    let claims;
    try {
      claims = jwt.verify(refreshToken, AUTH.JWT_REFRESH_SECRET);
    } catch {
      throw ApiError.unauthenticated('The refresh token is invalid or expired.');
    }

    const client = redis.getRedis();
    const tracked = await client.get(tokenKey(claims.jti));

    if (!tracked) {
      await revokeFamily(claims.family);
      logger.warn(`[auth] refresh reuse detected for user ${claims.sub}; family revoked`);
      throw ApiError.unauthenticated('This session has been revoked. Please sign in again.');
    }

    // Consume the presented token before minting its replacement.
    await client.del(tokenKey(claims.jti));
    await client.srem(familyKey(claims.family), claims.jti);

    const user = await users.findById(claims.sub);
    if (!user) throw ApiError.unauthenticated();

    const membership = await organizations.findMembership(user.id, claims.org);
    if (!membership) throw ApiError.unauthenticated();

    // Role and plan are re-read rather than copied from the old token, so a
    // downgrade or role change takes effect within one access-token lifetime
    // instead of persisting for the refresh token's whole 20 days.
    const plan = await organizations.planFor(membership.organization_id);
    const tokens = await issueTokens({
      userId: user.id,
      organizationId: membership.organization_id,
      role: membership.role,
      plan,
      family: claims.family,
    });

    return { ...tokens, role: membership.role, plan };
  }

  static async logout({ refreshToken }) {
    if (!refreshToken) return { revoked: false };
    try {
      const claims = jwt.verify(refreshToken, AUTH.JWT_REFRESH_SECRET);
      await revokeFamily(claims.family);
      return { revoked: true };
    } catch {
      // An unparseable token is already useless; logout stays idempotent.
      return { revoked: false };
    }
  }
}
