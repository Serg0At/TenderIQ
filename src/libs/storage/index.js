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

export default { getStorage, PREFIX, rawKey, tenderDocKey, tenderDocTextKey };
