import { Router } from 'express';
import Joi from 'joi';
import NotificationController from './notification.controller.js';
import { authenticate } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';

const router = Router();

const listQuery = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(50),
}).options({ stripUnknown: true });

// Reading your own alerts needs no more than tender:read — every role has it,
// including viewer, because being told about a tender is not a privileged act.
router.use(authenticate, authorize('tender:read'));

router.get('/', validate(listQuery, 'query'), NotificationController.list);
router.patch('/:id/read', NotificationController.markRead);

export default router;
