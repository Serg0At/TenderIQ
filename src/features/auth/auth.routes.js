import { Router } from 'express';
import AuthController from './auth.controller.js';
import { authenticateOrgless } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { rateLimit } from '../../middlewares/rateLimit.js';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  switchOrgSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  forgotPasswordSchema,
  verifyResetCodeSchema,
  resetPasswordSchema,
} from '../../validations/schemas/auth.schema.js';

const router = Router();

/**
 * A far tighter budget than the rest of the API: these are the endpoints worth
 * brute-forcing, and they are unauthenticated, so the limit keys on IP.
 */
const authLimit = rateLimit({ requests: 10, perMs: 60_000, bucket: 'auth' });

/**
 * Tighter still, and per hour rather than per minute, for the two endpoints
 * that send mail to an address the caller chose.
 *
 * The budget here is not really about brute force — it is about not being the
 * free mail cannon that delivers a stranger's inbox a hundred TenderIQ messages
 * an hour. A sender reputation is slow to build and quick to lose.
 */
const emailLimit = rateLimit({ requests: 5, perMs: 3_600_000, bucket: 'auth-email' });

/**
 * The reset-code checks get their own bucket so that guessing codes cannot eat
 * the budget the same person needs to actually sign in. The real ceiling on
 * guessing is the per-code attempt counter in `authStore.js` — this is the
 * outer wall, not the lock.
 */
const codeLimit = rateLimit({ requests: 10, perMs: 600_000, bucket: 'auth-code' });

router.post('/register', authLimit, validate(registerSchema), AuthController.register);
router.post('/login', authLimit, validate(loginSchema), AuthController.login);
router.post('/refresh', authLimit, validate(refreshSchema), AuthController.refresh);
router.post('/logout', validate(refreshSchema), AuthController.logout);

// Email confirmation. The token arrives in a body, not a query string: a link
// with the token in the URL leaks it to the referrer, the browser history and
// every proxy log on the way, so the emailed link lands on a client page that
// POSTs it here.
router.post('/verify-email', authLimit, validate(verifyEmailSchema), AuthController.verifyEmail);
router.post(
  '/verify-email/resend',
  emailLimit,
  validate(resendVerificationSchema),
  AuthController.resendVerification
);

// Password reset, in three steps: ask for a code, check it, spend it.
router.post(
  '/forgot-password',
  emailLimit,
  validate(forgotPasswordSchema),
  AuthController.forgotPassword
);
router.post(
  '/verify-reset-code',
  codeLimit,
  validate(verifyResetCodeSchema),
  AuthController.verifyResetCode
);
router.post('/reset-password', codeLimit, validate(resetPasswordSchema), AuthController.resetPassword);

// Orgless-allowed: a client booting up needs to learn that it is orgless.
router.get('/me', authenticateOrgless, AuthController.me);

/**
 * Which of your own memberships to act under. Authenticated, and deliberately
 * not behind `authorize`: there is no permission to hold, because choosing a
 * tenant is not an act inside one. Rate limited per user, since every call
 * mints a new refresh family in Redis.
 */
const switchLimit = rateLimit({ requests: 30, perMs: 60_000, bucket: 'auth-switch' });
router.post(
  '/switch-org',
  authenticateOrgless,
  switchLimit,
  validate(switchOrgSchema),
  AuthController.switchOrganization
);

export default router;
