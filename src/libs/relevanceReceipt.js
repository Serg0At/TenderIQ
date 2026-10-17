import crypto from 'crypto';
import config from '../configs/variables.config.js';

const { AUTH } = config;

/**
 * Proof of what the relevant list showed.
 *
 * When a supplier tracks a tender from the relevant list, the pursuit records
 * the score and reasons they were looking at — the only record connecting a
 * ranking to a human decision. It must be the ranking AS SHOWN: recomputing it
 * at track time would describe a list the supplier never saw, since history
 * moves constantly.
 *
 * So each relevant row carries a signature over exactly what it displayed, and
 * the client hands the row's relevance back when it tracks. Nothing is stored
 * per page view — writing a row per candidate per request would be ~150 writes
 * a page, stale on the next bid — and a client cannot forge a ranking into the
 * record that will one day judge whether the ranking works. A tender tracked
 * from anywhere else simply carries no relevance, and that absence is honest.
 *
 * Same construction as the unsubscribe token: an HMAC under the access-token
 * secret, domain-separated by a `relevance:` prefix so a digest minted here is
 * valid nowhere else. Bound to the organization and the tender, so a signature
 * cannot be replayed onto another tender or by another tenant.
 */

/** JSON with keys sorted at every depth, so the digest does not depend on key order. */
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const digest = (organizationId, tenderId, { score, band, reasons, shownAt }) =>
  crypto
    .createHmac('sha256', AUTH.JWT_ACCESS_SECRET ?? '')
    .update(`relevance:${canonical([organizationId, tenderId, score, band, reasons, shownAt])}`)
    .digest('hex');

/** The signature a relevant row carries for what it shows. */
export const signRelevance = (organizationId, tenderId, shown) => digest(organizationId, tenderId, shown);

/** Was this exactly what the relevant list showed this organization for this tender? */
export const verifyRelevance = (organizationId, tenderId, shown) => {
  if (!shown?.signature) return false;
  const expected = Buffer.from(digest(organizationId, tenderId, shown), 'utf8');
  const given = Buffer.from(String(shown.signature), 'utf8');
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
};

export default { signRelevance, verifyRelevance };
