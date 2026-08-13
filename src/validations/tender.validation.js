import { UnrecoverableError } from 'bullmq';
import { normalizedTenderSchema } from './schemas/tender.schema.js';

/** Validate and coerce a source-mapped tender before a database write. */
export const validateNormalizedTender = (tender) => {
  const { value, error } = normalizedTenderSchema.validate(tender, {
    abortEarly: false,
    convert: true,
  });

  if (error) {
    throw new UnrecoverableError(
      `invalid normalized tender: ${error.details.map((detail) => detail.message).join('; ')}`
    );
  }

  return value;
};

export default { validateNormalizedTender };
