import { Router } from 'express';
import SavedSearchController from './savedSearch.controller.js';
import { authenticate } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { createSavedSearchSchema, updateSavedSearchSchema } from '../../validations/schemas/savedSearch.schema.js';

const router = Router();

router.use(authenticate);

// Reading a profile only needs tender:read, but changing one needs
// savedsearch:write — which a `viewer` does not hold. That asymmetry is the
// whole point of separating the two permissions.
router.get('/', authorize('tender:read'), SavedSearchController.list);
router.post('/', authorize('savedsearch:write'), validate(createSavedSearchSchema), SavedSearchController.create);
router.patch('/:id', authorize('savedsearch:write'), validate(updateSavedSearchSchema), SavedSearchController.update);
router.delete('/:id', authorize('savedsearch:write'), SavedSearchController.remove);

export default router;
