/**
 * The API's error vocabulary.
 *
 * One enum, because the code is a contract: clients branch on it, so it must
 * stay stable even when the wording changes. The message is written for the
 * client and carries no stack, no SQL and no internal identifiers — full
 * context goes to the log with a correlation ref instead.
 */
export const ERROR = {
  VALIDATION_FAILED: { status: 422, message: 'The request failed validation.' },
  UNAUTHENTICATED: { status: 401, message: 'Authentication is required.' },
  TOKEN_EXPIRED: { status: 401, message: 'The access token has expired.' },
  PLAN_UPGRADE_REQUIRED: { status: 402, message: 'Your plan does not include this feature.' },
  ROLE_FORBIDDEN: { status: 403, message: 'Your role does not permit this action.' },
  /**
   * Its own code rather than a ROLE_FORBIDDEN, because the client has to tell
   * "you cannot do this" apart from "confirm your address and you can" — they
   * are different screens, and only one of them has a button on it.
   */
  EMAIL_UNVERIFIED: { status: 403, message: 'Confirm your email address to continue.' },
  TENANT_FORBIDDEN: { status: 403, message: 'That resource belongs to another organization.' },
  NOT_FOUND: { status: 404, message: 'Not found.' },
  CONFLICT: { status: 409, message: 'That conflicts with the current state.' },
  RATE_LIMITED: { status: 429, message: 'Too many requests.' },
  QUOTA_EXCEEDED: { status: 429, message: 'Plan quota exceeded.' },
  INTERNAL_ERROR: { status: 500, message: 'Something went wrong on our side.' },
  DEPENDENCY_UNAVAILABLE: { status: 503, message: 'A dependency is unavailable.' },
};

/**
 * An error a client is allowed to see.
 *
 * Anything thrown that is NOT one of these is treated as a bug by the error
 * handler and reported as INTERNAL_ERROR — so a stray database or driver error
 * can never leak its text into a response by accident.
 */
export class ApiError extends Error {
  constructor(code, { message, details } = {}) {
    const spec = ERROR[code] ?? ERROR.INTERNAL_ERROR;
    super(message ?? spec.message);
    this.name = 'ApiError';
    this.code = ERROR[code] ? code : 'INTERNAL_ERROR';
    this.status = spec.status;
    this.details = details;
    this.expected = true;
  }

  static unauthenticated(message) {
    return new ApiError('UNAUTHENTICATED', { message });
  }
  static forbidden(code = 'ROLE_FORBIDDEN', details) {
    return new ApiError(code, { details });
  }
  static notFound(what = 'Resource') {
    return new ApiError('NOT_FOUND', { message: `${what} not found.` });
  }
  static conflict(message, details) {
    return new ApiError('CONFLICT', { message, details });
  }
  static validation(details) {
    return new ApiError('VALIDATION_FAILED', { details });
  }
}

export default { ERROR, ApiError };
