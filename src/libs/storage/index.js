import config from '../../configs/variables.config.js';

export const PREFIX = {
  RAW: 'raw',
  TENDER_DOCS: 'tender-docs',
  VAULT: 'vault',
  EXPORTS: 'exports',
};

export const rawKey = ({ source, ref, hash, ext = 'html' }) =>
  `${PREFIX.RAW}/${source}/${encodeURIComponent(ref)}/${hash}.${ext}`;

export const tenderDocKey = ({ source, sourceId, hash, ext }) =>
  `${PREFIX.TENDER_DOCS}/${source}/${encodeURIComponent(sourceId)}/${hash}.${ext}`;

export const tenderDocTextKey = ({ source, sourceId, hash }) =>
  `${PREFIX.TENDER_DOCS}/${source}/${encodeURIComponent(sourceId)}/${hash}.txt`;

/**
 * Where one organisation's vault documents live.
 *
 * Namespaced by organisation and content-addressed, in that order, and minted
 * HERE rather than accepted from the client. The upload is a presigned PUT, so
 * a client-supplied key would be a client-supplied write target — one org
 * writing into another's prefix. Tenant isolation in object storage is key
 * namespacing plus the authorization check, and this function is the first half.
 *
 * The hash tail makes a re-upload of identical bytes an overwrite rather than a
 * second object, matching the (organization_id, hash) dedupe on the row.
 */
export const vaultKey = ({ organizationId, hash, ext = 'bin' }) =>
  `${PREFIX.VAULT}/${encodeURIComponent(organizationId)}/${hash}.${ext}`;

let instance = null;

export const getStorage = async () => {
  if (instance) return instance;
  const module =
    config.STORAGE.DRIVER === 'local'
      ? await import('./local.storage.js')
      : await import('./s3.storage.js');
  instance = module.create();
  return instance;
};

export default { getStorage, PREFIX, rawKey, tenderDocKey, tenderDocTextKey, vaultKey };
