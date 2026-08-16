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

    /**
     * Every key under a prefix, with the timestamp the object was written.
     *
     * Exists so `source_payloads` can be rebuilt from storage rather than
     * re-crawled — see scripts/reindexPayloads.js. Async generator because the
     * S3 driver pages, and a caller that streams works against both.
     */
    async *list(prefix = '') {
      const base = resolve(prefix);
      const walk = async function* (dir) {
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (error) {
          if (error.code === 'ENOENT') return;
          throw error;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            yield* walk(full);
          } else {
            const stat = await fs.stat(full);
            yield {
              key: path.relative(root, full).split(path.sep).join('/'),
              size: stat.size,
              lastModified: stat.mtime,
            };
          }
        }
      };
      yield* walk(base);
    },

    async signedUrl(key) {
      return `file://${resolve(key)}`;
    },
  };
};

export default { create };
