import { Router } from 'express';
import TrackedTenderController from './trackedTender.controller.js';
import ChecklistController from './checklist.controller.js';
import { authenticate } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import {
  trackTenderSchema,
  updateTrackedTenderSchema,
  trackedTenderQuerySchema,
  saveBidSchema,
  submitBidSchema,
  generateChecklistSchema,
  addChecklistItemSchema,
  updateChecklistItemSchema,
} from '../../validations/schemas/trackedTender.schema.js';
import { attachDocumentSchema } from '../../validations/schemas/vaultDocument.schema.js';

const router = Router();

router.use(authenticate);

/**
 * Reading the pipeline needs only `tender:read`; changing it needs
 * `trackedtender:write`, and touching a price needs `bid:write`. The three are
 * separate permissions in the matrix precisely so a `viewer` can watch the
 * board without being able to move a card or set a number on it.
 */
router.get('/', authorize('tender:read'), validate(trackedTenderQuerySchema, 'query'), TrackedTenderController.list);

// Before /:id, or "board" and "performance" would be read as tracked-tender ids
// and answer 404 for everyone.
router.get('/board', authorize('tender:read'), TrackedTenderController.board);
router.get('/performance', authorize('tender:read'), TrackedTenderController.performance);

router.post('/', authorize('trackedtender:write'), validate(trackTenderSchema), TrackedTenderController.track);
router.get('/:id', authorize('tender:read'), TrackedTenderController.detail);
router.patch('/:id', authorize('trackedtender:write'), validate(updateTrackedTenderSchema), TrackedTenderController.update);
router.delete('/:id', authorize('trackedtender:write'), TrackedTenderController.remove);

/**
 * The bid is a subresource, not its own collection: `bids.tracked_tender_id` is
 * UNIQUE, so there is exactly one per pursuit and it has no identity worth
 * addressing separately.
 *
 * Submitting is a POST to its own path rather than a PATCH setting
 * `locked: true`. It is not a field assignment — it locks a snapshot, advances
 * the pipeline and tries to resolve the outcome — and a client should not be
 * able to reach that by guessing at a boolean.
 */
router.put('/:id/bid', authorize('bid:write'), validate(saveBidSchema), TrackedTenderController.saveBid);
router.post('/:id/bid/submit', authorize('bid:write'), validate(submitBidSchema), TrackedTenderController.submitBid);
router.delete('/:id/bid', authorize('bid:write'), TrackedTenderController.removeBid);

/**
 * The AI bid checklist, a subresource of the pursuit it belongs to.
 *
 * Reading needs `tender:read`; generating needs `bid:write`, because it spends
 * money — one model call over a full invitation per run — and that is a
 * stronger act than viewing. A `viewer` can read the checklist and tick
 * nothing.
 *
 * POST /generate is asynchronous and answers 202: the extraction takes tens of
 * seconds, so the client polls GET for the status.
 */
router.get('/:id/checklist', authorize('tender:read'), ChecklistController.get);
router.post(
  '/:id/checklist/generate',
  authorize('bid:write'),
  validate(generateChecklistSchema),
  ChecklistController.generate
);
router.post(
  '/:id/checklist/items',
  authorize('bid:write'),
  validate(addChecklistItemSchema),
  ChecklistController.addItem
);
// Items are addressed by their own id: ticking one off is the most frequent
// write in the whole feature and should not require the parent in the path.
router.patch(
  '/checklist/items/:itemId',
  authorize('bid:write'),
  validate(updateChecklistItemSchema),
  ChecklistController.updateItem
);
/**
 * Which vault document satisfies this requirement.
 *
 * Needs `bid:write` rather than `vault:write`: attaching does not change the
 * document, it changes the bid — a coordinator preparing a submission should
 * not need permission to alter the company's certificate store to say which one
 * they are using.
 */
router.patch(
  '/checklist/items/:itemId/document',
  authorize('bid:write'),
  validate(attachDocumentSchema),
  ChecklistController.attachDocument
);
router.delete('/checklist/items/:itemId', authorize('bid:write'), ChecklistController.removeItem);

export default router;
