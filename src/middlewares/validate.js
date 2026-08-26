import { ApiError } from '../utils/errors.js';

/**
 * Joi at the HTTP boundary.
 *
 * Validation runs at every boundary, not just this one — job payloads and
 * scraped data get the same treatment — but this is where untrusted input is
 * densest.
 *
 * `stripUnknown` is the point: the validated value REPLACES the original, so a
 * field nobody declared cannot ride along into a service and reach a column it
 * was never meant to touch (mass assignment). Every error is collected rather
 * than failing on the first, because a form that reveals one problem per
 * round-trip is miserable to use.
 */
export const validate = (schema, property = 'body') => (req, _res, next) => {
  const { value, error } = schema.validate(req[property], {
    abortEarly: false,
    convert: true,
    stripUnknown: true,
  });

  if (error) {
    return next(
      ApiError.validation(
        error.details.map((d) => ({ field: d.path.join('.'), message: d.message }))
      )
    );
  }

  // Express 5 defines `query` as a getter on the request prototype, so a plain
  // assignment throws TypeError and every validated GET route 500s. Defining an
  // own property shadows the getter, and behaves identically for `body`.
  Object.defineProperty(req, property, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return next();
};

export default { validate };
