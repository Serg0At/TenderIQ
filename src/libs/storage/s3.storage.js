import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import config from '../../configs/variables.config.js';

const { STORAGE } = config;

export const create = () => {
  const client = new S3Client({
    region: STORAGE.REGION,
    ...(STORAGE.ENDPOINT ? { endpoint: STORAGE.ENDPOINT } : {}),
    forcePathStyle: STORAGE.FORCE_PATH_STYLE,
    ...(STORAGE.ACCESS_KEY && STORAGE.SECRET_KEY
      ? {
          credentials: {
            accessKeyId: STORAGE.ACCESS_KEY,
            secretAccessKey: STORAGE.SECRET_KEY,
          },
        }
      : {}),
  });

  const streamToBuffer = async (stream) => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  };

  return {
    async put(key, body, { contentType, metadata } = {}) {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const result = await client.send(
        new PutObjectCommand({
          Bucket: STORAGE.BUCKET,
          Key: key,
          Body: buffer,
          ContentType: contentType || 'application/octet-stream',
          Metadata: metadata,
          // Buckets are private; access is always via signed URL
          // (docs/technical/File Storage.md: "no public buckets").
          //
          // SSE defaults to AES256 so production is encrypted unless someone
          // deliberately opts out — the reverse default would ship plaintext the
          // first time an env var went missing. MinIO rejects AES256 without a
          // KMS backend, so local dev sets S3_SSE=none.
          ...(STORAGE.SSE && STORAGE.SSE !== 'none'
            ? { ServerSideEncryption: STORAGE.SSE }
            : {}),
        })
      );
      return { key, size: buffer.length, etag: result.ETag };
    },

    async get(key) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: STORAGE.BUCKET, Key: key })
      );
      return streamToBuffer(result.Body);
    },

    async head(key) {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: STORAGE.BUCKET, Key: key })
        );
        return { size: result.ContentLength, contentType: result.ContentType };
      } catch (error) {
        if (error.$metadata && error.$metadata.httpStatusCode === 404) return null;
        throw error;
      }
    },

    /**
     * Erase an object.
     *
     * Exists for vault documents only. Raw payloads are kept forever by design —
     * they are what lets normalization replay after a parser fix without
     * re-crawling — but a customer's certificate is theirs, and "deletion on
     * request" is not satisfied by hiding a row while the file remains.
     *
     * S3 DELETE is idempotent and reports success for a key that was never
     * there, which is the behaviour a retry wants.
     */
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: STORAGE.BUCKET, Key: key }));
      return { key, deleted: true };
    },

    /**
     * Every key under a prefix, with the timestamp the object was written.
     *
     * Exists so `source_payloads` can be rebuilt from storage rather than
     * re-crawled — see scripts/reindexPayloads.js. Yields as it pages rather
     * than accumulating, because the raw bucket grows without bound by design.
     */
    async *list(prefix = '') {
      let ContinuationToken;
      do {
        const result = await client.send(
          new ListObjectsV2Command({
            Bucket: STORAGE.BUCKET,
            Prefix: prefix,
            ContinuationToken,
          })
        );
        for (const object of result.Contents ?? []) {
          yield { key: object.Key, size: object.Size, lastModified: object.LastModified };
        }
        ContinuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
      } while (ContinuationToken);
    },

    signedUrl(key, ttlSeconds = 900) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: STORAGE.BUCKET, Key: key }), {
        expiresIn: ttlSeconds,
      });
    },

    /**
     * A time-limited URL the client PUTs bytes to directly, and the exact
     * headers that PUT must carry.
     *
     * Vault documents are the only thing uploaded by a customer rather than
     * fetched by a scraper, and they are the one case where the bytes must not
     * pass through the API: a 20 MB scan through an express handler is memory
     * pressure on the process that serves every other request, and the JSON body
     * limit stays at 1 MB precisely because of this method.
     *
     * `signableHeaders` is the part that is easy to get wrong. By default the
     * presigner signs only `host`, and every other header is advisory — a client
     * could then upload an executable to a key the vault records as a PDF, or
     * skip encryption entirely, and storage would accept it. Naming them here
     * pulls them into `X-Amz-SignedHeaders`, which makes them binding: a PUT that
     * sends a different content type, a different length, or omits the
     * encryption header fails the signature and never lands.
     *
     * That is also why the headers come back to the caller — the client cannot
     * guess them, and a mismatch is a 403 from storage with no explanation.
     * ContentLength being signed is what makes the declared size a limit rather
     * than a hint: an oversized body is rejected by storage, not discovered
     * afterwards.
     */
    async signedUploadUrl(key, { contentType, contentLength, ttlSeconds = 900 } = {}) {
      const type = contentType || 'application/octet-stream';
      const sse = STORAGE.SSE && STORAGE.SSE !== 'none' ? STORAGE.SSE : null;

      const headers = {
        'Content-Type': type,
        ...(sse ? { 'x-amz-server-side-encryption': sse } : {}),
      };

      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: STORAGE.BUCKET,
          Key: key,
          ContentType: type,
          ...(contentLength ? { ContentLength: contentLength } : {}),
          ...(sse ? { ServerSideEncryption: sse } : {}),
        }),
        {
          expiresIn: ttlSeconds,
          signableHeaders: new Set([
            'content-type',
            ...(contentLength ? ['content-length'] : []),
            ...(sse ? ['x-amz-server-side-encryption'] : []),
          ]),
        }
      );

      return { url, headers };
    },
  };
};

export default { create };
