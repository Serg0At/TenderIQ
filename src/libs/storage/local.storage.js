import fs from 'fs/promises';
import path from 'path';
import config from '../../configs/variables.config.js';

/**
 * Filesystem driver for local dev and tests, so the scraping pipeline can be
 * exercised without MinIO running. Same port as s3.storage.js.
 */
export const create = () => {
  const root = path.resolve(config.STORAGE.LOCAL_ROOT);
  const resolve = (key) => path.join(root, key);

  return {
    async put(key, body, { contentType } = {}) {
      const target = resolve(key);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
      await fs.writeFile(target, buffer);
      return { key, size: buffer.length, etag: null, contentType };
    },

    async get(key) {
      return fs.readFile(resolve(key));
    },

    async head(key) {
      try {
        const stat = await fs.stat(resolve(key));
        return { size: stat.size, contentType: null };
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },

    async signedUrl(key) {
      return `file://${resolve(key)}`;
    },
  };
};

export default { create };
