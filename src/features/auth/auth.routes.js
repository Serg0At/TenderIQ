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

const authLimit = rateLimit({ requests: 10, perMs: 60_000, bucket: 'auth' });
const emailLimit = rateLimit({ requests: 5, perMs: 3_600_000, bucket: 'auth-email' });
const codeLimit = rateLimit({ requests: 10, perMs: 600_000, bucket: 'auth-code' });

router.post('/register', authLimit, validate(registerSchema), AuthController.register);
router.post('/login', authLimit, validate(loginSchema), AuthController.login);
router.post('/refresh', authLimit, validate(refreshSchema), AuthController.refresh);
router.post('/logout', validate(refreshSchema), AuthController.logout);

router.post('/verify-email', authLimit, validate(verifyEmailSchema), AuthController.verifyEmail);
router.post('/verify-email/resend', emailLimit, validate(resendVerificationSchema), AuthController.resendVerification);


router.post('/forgot-password', emailLimit, validate(forgotPasswordSchema), AuthController.forgotPassword);
router.post('/verify-reset-code', codeLimit, validate(verifyResetCodeSchema), AuthController.verifyResetCode);
router.post('/reset-password', codeLimit, validate(resetPasswordSchema), AuthController.resetPassword);

// Orgless-allowed: a client booting up needs to learn that it is orgless.
router.get('/me', authenticateOrgless, AuthController.me);

const switchLimit = rateLimit({ requests: 30, perMs: 60_000, bucket: 'auth-switch' });
router.post('/switch-org', authenticateOrgless, switchLimit, validate(switchOrgSchema), AuthController.switchOrganization);

export default router;
