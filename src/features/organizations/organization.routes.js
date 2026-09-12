import { Router } from 'express';
import OrganizationController from './organization.controller.js';
import { authenticate } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { rateLimit } from '../../middlewares/rateLimit.js';
import { createOrganizationSchema } from '../../validations/schemas/organization.schema.js';

const router = Router();

router.use(authenticate);

/**
 * The collection of organizations, as opposed to `/organization` — the one the
 * session is acting in.
 *
 * Creating one takes no `authorize`: there is no tenant yet to hold a role in.
 * The per-account cap in the service is the real limit; this budget, keyed on
 * the user because it runs after `authenticate`, stops a script hammering the
 * transaction that enforces it.
 */
const createLimit = rateLimit({ requests: 10, perMs: 3_600_000, bucket: 'org-create' });

router.post('/', createLimit, validate(createOrganizationSchema), OrganizationController.create);

export default router;
