const { getAuthContextByToken } = require('../services/authService');
const { createHttpError } = require('../utils/errors');

function extractBearerToken(authorizationHeader) {
  const normalized = String(authorizationHeader || '').trim();
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const token = String(match[1] || '').trim();
  return token || null;
}

function requireAuth(req, res, next) {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    return next(createHttpError(401, 'UNAUTHORIZED', 'Authentication required.', {
      retryable: false,
    }));
  }

  const authContext = getAuthContextByToken(token);
  if (!authContext?.user) {
    return next(createHttpError(401, 'UNAUTHORIZED', 'Authentication required.', {
      retryable: false,
    }));
  }

  req.user = authContext.user;
  req.authSession = {
    id: authContext.sessionId,
    expiresAt: authContext.expiresAt,
  };

  return next();
}

module.exports = requireAuth;
