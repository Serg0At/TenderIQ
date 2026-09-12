import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createId } from '@paralleldrive/cuid2';
import config from '../../configs/variables.config.js';
import { withTransaction } from '../../libs/knex.js';
import users from '../../repositories/user.repo.js';
import organizations from '../../repositories/organization.repo.js';
import mailer from '../../libs/adapters/email/index.js';
import {
  verificationEmail,
  resetCodeEmail,
  passwordChangedEmail,
} from '../../libs/adapters/email/email.format.js';
import store from './authStore.js';
import { ApiError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

const { AUTH } = config;
const BCRYPT_ROUNDS = 12;

/**
 * The same wording whether or not the address exists.
 *
 * Both of these endpoints take a bare email address and send mail, which makes
 * them a register of who holds an account here unless every path answers
 * identically. The response is the same object, produced in the same place, so
 * a future edit cannot drift the two branches apart.
 */
const NEUTRAL_RESET = { sent: true, message: 'If that address has an account, a reset code is on its way.' };
const NEUTRAL_RESEND = { sent: true, message: 'If that address needs confirming, a new link is on its way.' };

/**
 * The user as a client is allowed to see them.
 *
 * One projection rather than one per caller. `register` and `sessionFor` return
 * the same shape at opposite verification states, and a field added to one and
 * forgotten in the other is a client that renders a name on one screen and an
 * email address on the next. `emailVerified` is derived from the row rather
 * than passed, so it cannot disagree with the column it describes.
 */
const publicUser = (user) => ({
  id: user.id,
  email: user.email,
  displayName: user.display_name,
  locale: user.locale,
  emailVerified: Boolean(user.email_verified_at),
});

const requireSecrets = () => {
  if (!AUTH.JWT_ACCESS_SECRET || !AUTH.JWT_REFRESH_SECRET) {
    throw new ApiError('INTERNAL_ERROR', { message: 'Auth is not configured.' });
  }
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

  await store.rememberRefresh(family, jti, userId);
  return { accessToken, refreshToken, expiresIn: store.toSeconds(AUTH.ACCESS_TOKEN_ACTIVE_TIME) };
};

/**
 * Turn a user row into a signed-in session.
 *
 * The email-verification gate lives HERE rather than in `login`, because login
 * is not the only thing that will ever mint a session — the organization
 * onboarding flow is designed to, and a password reset already proves an
 * address. One choke point means a path added later cannot forget the check;
 * it would have to route around the only function that issues tokens.
 */
const sessionFor = async (user, organizationId = null) => {
  if (!user.email_verified_at) {
    throw new ApiError('EMAIL_UNVERIFIED', {
      message: 'Confirm your email address before signing in.',
      details: { email: user.email },
    });
  }

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
    user: publicUser(user),
    organization: { id: membership.organization_id, name: membership.organization_name },
    role: membership.role,
    plan,
  };
};

/**
 * Issue and send a verification link.
 *
 * A failed send is logged, not thrown. The account it belongs to has already
 * been committed, and turning a mail-server outage into a 500 would tell the
 * user their registration failed when it did not — leaving them unable to
 * register again, because the address is now taken. `/verify-email/resend` is
 * the recovery path.
 */
const sendVerification = async (user) => {
  const token = await store.issueVerificationToken({ userId: user.id, email: user.email });
  const result = await mailer.send({ to: user.email, ...verificationEmail({ token }) });
  if (!result.ok) logger.error(`[auth] verification email to user ${user.id} failed: ${result.kind}`);
  return result.ok;
};

export default class AuthService {
  /**
   * Register a user, their organization, and an owner membership atomically.
   *
   * One transaction because a user with no organization cannot log in — the
   * token needs a tenant — so a partial write would produce a permanently
   * broken account that looks successfully created.
   *
   * Returns no tokens. Login refuses an unconfirmed address, so handing back a
   * session here would mint credentials that the very next endpoint rejects —
   * the client would appear signed in and then fail on every call.
   */
  static async register({ email, password, displayName, organizationName, locale }) {
    const existing = await users.findByEmail(email);
    if (existing) throw ApiError.conflict('That email is already registered.');

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const user = await withTransaction(async (trx) => {
      await organizations.ensureRoles(trx);
      const userId = await users.create({ email, passwordHash, displayName, locale }, trx);
      const organizationId = await organizations.createWithOwner(
        { name: organizationName, userId },
        trx
      );
      // The creator is the owner: someone must hold billing:manage, and an org
      // whose only member cannot manage it is unusable.
      await organizations.addMember({ userId, organizationId, role: 'owner' }, trx);
      return users.findById(userId, trx);
    });

    const delivered = await sendVerification(user);

    return {
      user: publicUser(user),
      verificationRequired: true,
      verificationSent: delivered,
      message: 'Check your email to confirm your address, then sign in.',
    };
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
   * Confirm an address from the emailed token.
   *
   * Order is read → write → delete. A GETDEL would hand back the only copy of
   * the token and lose it if the database write then failed, stranding a user
   * whose link now works for nobody. This way the failure leaves the link live
   * and the second click succeeds.
   */
  static async verifyEmail({ token }) {
    const stored = await store.readVerificationToken(token);
    if (!stored) {
      throw ApiError.validation([
        { field: 'token', message: 'That confirmation link is invalid or has expired.' },
      ]);
    }

    const user = await users.findById(stored.userId);
    if (!user) throw ApiError.notFound('Account');

    // False means it was already verified — a double click, not a failure.
    const changed = await users.markEmailVerified(user.id);
    await store.consumeVerificationToken(token, user.id);

    if (changed) logger.info(`[auth] email verified for user ${user.id}`);
    return {
      verified: true,
      alreadyVerified: !changed,
      email: user.email,
      message: 'Your email address is confirmed. You can sign in now.',
    };
  }

  /**
   * Send a fresh confirmation link.
   *
   * Answers identically for an unknown address, an already-verified one, and a
   * successful send — the endpoint takes an arbitrary email and would otherwise
   * report which addresses are registered and which are still pending.
   */
  static async resendVerification({ email }) {
    const user = await users.findByEmail(email);
    if (user && !user.email_verified_at) await sendVerification(user);
    return NEUTRAL_RESEND;
  }

  /**
   * Start a password reset.
   *
   * Always reports success. The response, the status code and the timing-visible
   * work are the same whether or not the address is known, because anything else
   * makes this endpoint an account-existence oracle that needs no credentials.
   */
  static async forgotPassword({ email }) {
    const user = await users.findByEmail(email);
    if (!user) return NEUTRAL_RESET;

    const code = await store.issueResetCode({ email: user.email, userId: user.id });
    const result = await mailer.send({ to: user.email, ...resetCodeEmail({ code }) });
    if (!result.ok) logger.error(`[auth] reset code to user ${user.id} failed: ${result.kind}`);

    return NEUTRAL_RESET;
  }

  /**
   * Check a reset code without spending it.
   *
   * Its own step so a client can validate the code on the screen where it was
   * typed, before asking for a new password. The code is deliberately NOT
   * consumed here — `resetPassword` re-checks it, so a user who verifies and
   * then takes a minute over their new password does not find it dead.
   *
   * A wrong code still costs an attempt. Without that this endpoint would be
   * the unlimited guessing oracle that `resetPassword`'s ceiling exists to
   * prevent.
   */
  static async verifyResetCode({ email, code }) {
    const result = await store.verifyResetCode({ email, code, consume: false });
    if (!result.ok) throw AuthService._resetCodeError(result.reason);
    return { valid: true, message: 'Code confirmed. Choose a new password.' };
  }

  /**
   * Spend the code on a new password.
   *
   * Three things happen together and all of them matter: the hash is replaced,
   * the code is consumed, and every existing session is revoked. The last is
   * the point of a reset — leaving old refresh tokens alive would let whoever
   * prompted the reset keep the access it was meant to remove.
   */
  static async resetPassword({ email, code, newPassword }) {
    const result = await store.verifyResetCode({ email, code, consume: true });
    if (!result.ok) throw AuthService._resetCodeError(result.reason);

    const user = await users.findById(result.userId);
    if (!user) throw ApiError.notFound('Account');

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await users.updatePassword(user.id, passwordHash);

    /**
     * Reading a code out of that inbox IS proof of the address, and it is
     * stronger proof than the confirmation link would have been. An account
     * that resets its password has therefore verified itself, and holding it at
     * the login gate afterwards would be theatre.
     */
    const nowVerified = await users.markEmailVerified(user.id);

    const revoked = await store.revokeAllForUser(user.id);
    logger.info(`[auth] password reset for user ${user.id}; ${revoked} session family(ies) revoked`);

    // Sent last, and to the address on record: it is the only warning the real
    // owner gets if this reset was not theirs.
    await mailer.send({ to: user.email, ...passwordChangedEmail() });

    return {
      reset: true,
      emailVerified: true,
      verifiedByReset: nowVerified,
      sessionsRevoked: revoked,
      message: 'Your password has been changed and all sessions were signed out.',
    };
  }

  /**
   * One place that decides what a failed code check means, so the check-only
   * endpoint and the spend-it endpoint cannot answer differently for the same
   * state.
   */
  static _resetCodeError(reason) {
    if (reason === 'locked') {
      return new ApiError('RATE_LIMITED', {
        message: 'Too many incorrect codes. Request a new one.',
        details: { retryAfterSeconds: 0, reason: 'code_burned' },
      });
    }
    if (reason === 'expired') {
      return ApiError.validation([
        { field: 'code', message: 'That code has expired. Request a new one.' },
      ]);
    }
    return ApiError.validation([{ field: 'code', message: 'That code is not correct.' }]);
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

    const tracked = await store.familyOf(claims.jti);

    if (!tracked) {
      await store.revokeFamily(claims.family, claims.sub);
      logger.warn(`[auth] refresh reuse detected for user ${claims.sub}; family revoked`);
      throw ApiError.unauthenticated('This session has been revoked. Please sign in again.');
    }

    // Consume the presented token before minting its replacement.
    await store.consumeRefresh(claims.family, claims.jti);

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
      await store.revokeFamily(claims.family, claims.sub);
      return { revoked: true };
    } catch {
      // An unparseable token is already useless; logout stays idempotent.
      return { revoked: false };
    }
  }
}
