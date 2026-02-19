const { ZodError } = require('zod');
const { createHttpError } = require('../utils/errors');

function formatZodError(error) {
  if (!(error instanceof ZodError) || error.issues.length === 0) {
    return 'Invalid request payload.';
  }

  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path?.length > 0 ? issue.path.join('.') : 'request';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function validateSchema(schema, source = 'body') {
  return function schemaValidationMiddleware(req, res, next) {
    try {
      const parsed = schema.parse(req[source]);
      req[source] = parsed;
      return next();
    } catch (error) {
      if (error instanceof ZodError) {
        return next(createHttpError(422, 'VALIDATION_ERROR', formatZodError(error), {
          retryable: false,
        }));
      }
      return next(error);
    }
  };
}

module.exports = validateSchema;
