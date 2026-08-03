import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
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

    signedUrl(key, ttlSeconds = 900) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: STORAGE.BUCKET, Key: key }), {
        expiresIn: ttlSeconds,
      });
    },
  };
};

export default { create };
