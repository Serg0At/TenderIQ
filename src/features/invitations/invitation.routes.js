import { Router } from 'express';
import InvitationController from './invitation.controller.js';
import { authenticate, authenticateOrgless } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { rateLimit } from '../../middlewares/rateLimit.js';
import {
  sendInvitationSchema,
  invitationQuerySchema,
  myInvitationQuerySchema,
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

/**
 * Offers addressed to the caller: `/invitations`.
 *
 * On the orgless allowlist — accepting an invitation is one of the two ways out
 * of having no organization. No permission: an offer addressed to you is yours
 * to read and answer, and there is no tenant yet to hold a role in.
 */
export const myInvitationRoutes = Router();

myInvitationRoutes.use(authenticateOrgless);

const answerLimit = rateLimit({ requests: 30, perMs: 60_000, bucket: 'invite-answer' });

myInvitationRoutes.get('/', validate(myInvitationQuerySchema, 'query'), InvitationController.listMine);
myInvitationRoutes.post('/:id/accept', answerLimit, InvitationController.accept);
myInvitationRoutes.post('/:id/decline', answerLimit, InvitationController.decline);

export default { organizationInvitationRoutes, myInvitationRoutes };
