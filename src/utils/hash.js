import crypto from 'crypto';

/** Content hash of a fetched body. Used for the stored raw payload. */
export const sha256 = (input) =>
  crypto
    .createHash('sha256')
    .update(Buffer.isBuffer(input) ? input : String(input))
    .digest('hex');

/**
 * Key-order-independent hash of an object's meaningful fields.
 *
 * This is the change-detection primitive. Hashing the *page* would be useless:
 * listing HTML churns on every request (sidebar calendar, counters), so every
 * fetch would look like a change. Hashing the *extracted fields* means the digest
 * only moves when something a supplier would act on has moved.
 *
 * null/undefined are dropped rather than serialised, so a field that flips
 * between absent and null does not read as an amendment. Dates are normalised to
 * ISO strings so a Date and its string form agree.
 */
export const stableHash = (obj) => {
  const canonical = JSON.stringify(
    Object.keys(obj)
      .sort()
      .reduce((acc, key) => {
        const value = obj[key];
        if (value !== undefined && value !== null) {
          acc[key] = value instanceof Date ? value.toISOString() : value;
        }
        return acc;
      }, {})
  );
  return sha256(canonical);
};

export default { sha256, stableHash };
