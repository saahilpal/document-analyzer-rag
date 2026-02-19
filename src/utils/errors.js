const SAFE_CLIENT_STATUS_CODES = new Set([400, 401, 403, 404, 409, 413, 415, 422, 429]);

const STATUS_CODE_DEFAULTS = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
};

function isRetryableStatus(status) {
  return status >= 500 || status === 429;
}

function sanitizeErrorCode(value, fallbackCode) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return fallbackCode;
  }
  return normalized.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

function toErrorObject(errorInput, status = 400) {
  const fallbackCode = STATUS_CODE_DEFAULTS[status] || STATUS_CODE_DEFAULTS[500];
  if (typeof errorInput === 'string') {
    const code = sanitizeErrorCode(errorInput, fallbackCode);
    return {
      code,
      message: errorInput,
      retryable: isRetryableStatus(status),
    };
  }

  if (errorInput && typeof errorInput === 'object') {
    const code = sanitizeErrorCode(errorInput.code, fallbackCode);
    const message = String(errorInput.message || errorInput.error || 'Request failed.');
    const retryable = typeof errorInput.retryable === 'boolean'
      ? errorInput.retryable
      : isRetryableStatus(status);
    return {
      code,
      message,
      retryable,
    };
  }

  return {
    code: fallbackCode,
    message: status === 500 ? 'Internal server error.' : 'Request failed.',
    retryable: isRetryableStatus(status),
  };
}

function createHttpError(statusCode, codeOrMessage, messageOrOptions, maybeOptions) {
  const candidateStatus = Number(statusCode) || 500;
  const status = SAFE_CLIENT_STATUS_CODES.has(candidateStatus) ? candidateStatus : 500;

  let code = null;
  let message = null;
  let options = {};

  if (typeof messageOrOptions === 'string') {
    code = codeOrMessage;
    message = messageOrOptions;
    options = maybeOptions || {};
  } else {
    code = null;
    message = codeOrMessage;
    options = messageOrOptions || {};
  }

  const normalized = toErrorObject({
    code,
    message,
    retryable: options.retryable,
  }, status);

  const error = new Error(normalized.message);
  error.statusCode = status;
  error.code = normalized.code;
  error.retryable = normalized.retryable;
  return error;
}

function normalizeHttpError(error) {
  const candidateStatus = Number(error?.statusCode || error?.status) || 500;
  const status = SAFE_CLIENT_STATUS_CODES.has(candidateStatus) ? candidateStatus : 500;

  const normalized = status === 500
    ? toErrorObject({
      code: error?.code || STATUS_CODE_DEFAULTS[500],
      message: 'Internal server error.',
      retryable: true,
    }, status)
    : toErrorObject({
      code: error?.code,
      message: error?.message,
      retryable: error?.retryable,
    }, status);

  return {
    status,
    error: normalized,
  };
}

module.exports = {
  createHttpError,
  normalizeHttpError,
  toErrorObject,
  isRetryableStatus,
};
