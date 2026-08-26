import { Router } from 'express';
import AuthController from './auth.controller.js';
import { authenticate } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { rateLimit } from '../../middlewares/rateLimit.js';
import { registerSchema, loginSchema, refreshSchema } from '../../validations/schemas/auth.schema.js';

const router = Router();

/**
 * A far tighter budget than the rest of the API: these are the endpoints worth
 * brute-forcing, and they are unauthenticated, so the limit keys on IP.
 */
const authLimit = rateLimit({ requests: 10, perMs: 60_000, bucket: 'auth' });

router.post('/register', authLimit, validate(registerSchema), AuthController.register);
router.post('/login', authLimit, validate(loginSchema), AuthController.login);
router.post('/refresh', authLimit, validate(refreshSchema), AuthController.refresh);
router.post('/logout', validate(refreshSchema), AuthController.logout);
router.get('/me', authenticate, AuthController.me);

export default router;
