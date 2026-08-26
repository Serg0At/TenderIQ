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
export const authenticate = (req, _res, next) => {
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
    req.user = {
      id: claims.sub,
      organizationId: claims.org,
      role: claims.role,
      plan: claims.plan,
      tokenId: claims.jti,
    };
    return next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') return next(new ApiError('TOKEN_EXPIRED'));
    return next(ApiError.unauthenticated('The access token is invalid.'));
  }
};

export default { authenticate };
