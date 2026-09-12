import { Router } from 'express';
import InvitationController from './invitation.controller.js';
import { authenticate } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { rateLimit } from '../../middlewares/rateLimit.js';
import {
  sendInvitationSchema,
  invitationQuerySchema,
} from '../../validations/schemas/invitation.schema.js';

/**
 * The offers an organization has sent: `/organization/invitations`.
 *
 * All three need `user:manage`. Only sending is plan-gated — the growth
 * direction is what the plan sells, and listing or withdrawing an offer is not
 * growth.
 */
export const organizationInvitationRoutes = Router();

organizationInvitationRoutes.use(authenticate);

/**
 * Per user, per hour. Every send raises an announcement through the
 * organization's channels, so an uncapped loop is a message cannon pointed at
 * the organization's own Telegram chats and inboxes.
 */
const sendLimit = rateLimit({ requests: 60, perMs: 3_600_000, bucket: 'invite-send' });

organizationInvitationRoutes.post(
  '/',
  authorize('user:manage', { planGate: 'invitations' }),
  sendLimit,
  validate(sendInvitationSchema),
  InvitationController.send
);
organizationInvitationRoutes.get(
  '/',
  authorize('user:manage'),
  validate(invitationQuerySchema, 'query'),
  InvitationController.list
);
organizationInvitationRoutes.delete('/:id', authorize('user:manage'), InvitationController.cancel);

export default { organizationInvitationRoutes };
