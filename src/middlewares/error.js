import { createId } from '@paralleldrive/cuid2';
import { ApiError, ERROR } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** Anything reaching here without a route matched is a 404 in the standard shape. */
export const notFoundHandler = (req, _res, next) =>
  next(ApiError.notFound(`${req.method} ${req.path}`));

/**
 * The only place an error becomes a response.
 *
 * Two rules do the work. First, an error is only trusted if it was deliberately
 * constructed as an ApiError; everything else is a bug and becomes
 * INTERNAL_ERROR, so a Postgres message ("duplicate key value violates unique
 * constraint tenders_source_id_unique") can never surface to a client and hand
 * out the schema. Second, unexpected errors are logged in full against a
 * correlation ref that IS returned — the client gets an id to quote in a
 * support ticket, and nothing else.
 */
// eslint-disable-next-line no-unused-vars -- Express identifies handlers by arity
export const errorHandler = (error, req, res, _next) => {
  if (error instanceof ApiError || error?.expected) {
    if (error.status >= 500) logger.error(`[api] ${error.code}: ${error.message}`);
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
    });
  }

  const ref = createId();
  logger.error(`[api] unhandled ${req.method} ${req.originalUrl} ref=${ref}`, {
    message: error?.message,
    stack: error?.stack,
  });

  return res.status(ERROR.INTERNAL_ERROR.status).json({
    error: { code: 'INTERNAL_ERROR', message: ERROR.INTERNAL_ERROR.message, details: { ref } },
  });
};

export default { notFoundHandler, errorHandler };
