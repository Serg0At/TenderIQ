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

    /** Erase an object. Missing is success, matching the S3 driver's idempotence. */
    async remove(key) {
      try {
        await fs.unlink(resolve(key));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      return { key, deleted: true };
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

    /**
     * Not supported, and deliberately not faked.
     *
     * A presigned PUT is an HTTP endpoint the client uploads to; the filesystem
     * has no such thing, and returning a `file://` URL would hand back an
     * address the browser cannot write to — an upload that appears to be
     * offered and silently never arrives. Refusing names the problem instead.
     *
     * This driver exists so the scraping pipeline can run without MinIO, and
     * scraping only ever writes through put(). `docker compose up -d` brings up
     * MinIO by default, which is where vault uploads are exercised locally.
     */
    async signedUploadUrl() {
      throw new Error(
        'The local storage driver cannot presign uploads. Set STORAGE_DRIVER=s3 (MinIO is in docker-compose).'
      );
    },
  };
};

export default { create };
