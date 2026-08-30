import { Router } from 'express';
import VaultDocumentController from './vaultDocument.controller.js';
import { authenticate } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import {
  registerVaultDocumentSchema,
  updateVaultDocumentSchema,
  vaultQuerySchema,
} from '../../validations/schemas/vaultDocument.schema.js';

const router = Router();

router.use(authenticate);

/**
 * The document vault.
 *
 * `vault:read` and `vault:write` already existed in the role matrix — a `viewer`
 * can see what the company holds and download it, but cannot add, edit or
 * delete. Both permissions are ungated by plan: a supplier's own certificates
 * are their data, and holding them hostage behind a tier is not a product this
 * should be.
 *
 * Uploading is a handshake, not a POST of bytes. POST / registers the intent and
 * returns a presigned PUT; the client uploads straight to object storage; POST
 * /:id/confirm asks storage whether the object arrived. See the service for why
 * the file never passes through this process.
 */
router.get('/', authorize('vault:read'), validate(vaultQuerySchema, 'query'), VaultDocumentController.list);

// Before /:id, or both would be read as document ids and 404 for everyone.
router.get('/summary', authorize('vault:read'), VaultDocumentController.summary);
router.get('/options', authorize('vault:read'), VaultDocumentController.options);

router.post(
  '/',
  authorize('vault:write'),
  validate(registerVaultDocumentSchema),
  VaultDocumentController.register
);
router.post('/:id/confirm', authorize('vault:write'), VaultDocumentController.confirm);

router.get('/:id', authorize('vault:read'), VaultDocumentController.detail);
router.get('/:id/download', authorize('vault:read'), VaultDocumentController.download);
router.patch(
  '/:id',
  authorize('vault:write'),
  validate(updateVaultDocumentSchema),
  VaultDocumentController.update
);
// Deletes the stored file as well as the row — "deletion on request" is not
// satisfied by hiding a row while the certificate remains in the bucket.
router.delete('/:id', authorize('vault:write'), VaultDocumentController.remove);

export default router;
