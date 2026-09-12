import jwt from 'jsonwebtoken';
import config from '../configs/variables.config.js';
import { ApiError } from '../utils/errors.js';

const { AUTH } = config;

/**
 * Gate 1 of 4: is the token valid?
 *
 * Establishes who is asking and nothing more — role, tenant and plan are the
 * next three gates. Attaching the claims here rather than re-decoding downstream
 * means one definition of "the current user".
 *
 * Expiry is reported as its own code so a client can tell "refresh me" apart
 * from "log in again"; conflating them forces a full re-login every 15 minutes.
 */
const verifyBearer = (req, next, { allowOrgless }) => {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(ApiError.unauthenticated('A Bearer token is required.'));
  }
  if (!AUTH.JWT_ACCESS_SECRET) {
    // Refuse rather than fall back to a default secret: an unsigned-in-practice
    // API that appears to work is worse than one that plainly does not start.
    return next(new ApiError('INTERNAL_ERROR', { message: 'Auth is not configured.' }));
  }

  try {
    const claims = jwt.verify(token, AUTH.JWT_ACCESS_SECRET);
    if (!claims.org && !allowOrgless) {
      return next(ApiError.forbidden('NO_ORGANIZATION'));
    }
    // `org`, `role` and `plan` are all null for an orgless session. Normalised to
    // null rather than left undefined, so "no organization" has one spelling.
    req.user = {
      id: claims.sub,
      organizationId: claims.org ?? null,
      role: claims.role ?? null,
      plan: claims.plan ?? null,
      tokenId: claims.jti,
    };
    return next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') return next(new ApiError('TOKEN_EXPIRED'));
    return next(ApiError.unauthenticated('The access token is invalid.'));
  }
};

/**
 * The default: a valid token that is acting inside an organization.
 *
 * An orgless session (just registered, or just removed from a last
 * organization) is refused here with NO_ORGANIZATION, so a route that
 * authenticates and forgets to `authorize` still denies it. Default-deny lives
 * in the gate every private route already passes, not in remembering a second
 * one.
 */
export const authenticate = (req, _res, next) => verifyBearer(req, next, { allowOrgless: false });

/**
 * The orgless allowlist, spelled out as the routes that mount this instead.
 *
 * Every caller is a route an orgless session must reach to stop being orgless,
 * or to learn that it is: `POST /organizations`, the invitations addressed to
 * the caller, `POST /auth/switch-org` (the way out for a second device still
 * holding an orgless session after the first joined somewhere), and
 * `GET /auth/me`. Log out and refresh take no bearer token at all. Grep for this
 * name to audit the list; anything added to it needs the same justification.
 */
export const authenticateOrgless = (req, _res, next) => verifyBearer(req, next, { allowOrgless: true });

export default { authenticate, authenticateOrgless };
