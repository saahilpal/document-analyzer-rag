require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

require('./db/database');

const apiV1Route = require('./routes/apiV1');
const rateLimiter = require('./middleware/rateLimiter');
const { fail } = require('./routes/helpers');
const { createHttpError, normalizeHttpError } = require('./utils/errors');
const { logError } = require('./utils/logger');

const app = express();

const DEFAULT_ALLOWED_ORIGIN_PATTERNS = [
  /^http:\/\/localhost(:\d+)?$/i,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/i,
  /^https:\/\/localhost(:\d+)?$/i,
  /^https:\/\/127\.0\.0\.1(:\d+)?$/i,
];

function parseConfiguredOrigins(rawOrigins) {
  return String(rawOrigins || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const configuredOrigins = parseConfiguredOrigins(process.env.CORS_ALLOWED_ORIGINS);
const hasConfiguredOrigins = configuredOrigins.length > 0;

function isAllowedOrigin(origin, normalizedOrigin) {
  if (!origin) {
    return true;
  }

  if (hasConfiguredOrigins) {
    return configuredOrigins.includes(normalizedOrigin);
  }

  return DEFAULT_ALLOWED_ORIGIN_PATTERNS.some((rule) => rule.test(normalizedOrigin));
}

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true');

app.use(helmet({
  crossOriginResourcePolicy: false,
}));

app.use(cors({
  origin(origin, callback) {
    const normalizedOrigin = String(origin || '').trim();
    if (isAllowedOrigin(origin, normalizedOrigin)) {
      return callback(null, true);
    }
    const error = createHttpError(403, 'CORS_ORIGIN_BLOCKED', 'CORS origin not allowed.', {
      retryable: false,
    });
    return callback(error);
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Authorization'],
  credentials: false,
}));
app.use(morgan('dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

// Route-level authentication is applied inside /api/v1 router.
app.use('/api/v1', rateLimiter({ windowMs: 60_000, maxRequests: 100 }), apiV1Route);

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err?.name === 'MulterError') {
    logError('ERROR_UPLOAD', err, {
      route: req.originalUrl,
      method: req.method,
    });
    return fail(
      res,
      err.code === 'LIMIT_FILE_SIZE'
        ? createHttpError(400, 'UPLOAD_TOO_LARGE', 'Uploaded file exceeds configured size limit.')
        : createHttpError(400, 'UPLOAD_FAILED', 'Upload failed.'),
      400
    );
  }

  if (err?.type === 'entity.parse.failed') {
    return fail(res, createHttpError(400, 'INVALID_JSON', 'Invalid JSON body.'), 400);
  }

  if (err?.type === 'entity.too.large') {
    return fail(res, createHttpError(413, 'PAYLOAD_TOO_LARGE', 'Request payload too large.'), 413);
  }

  const isSqliteError = String(err?.code || '').startsWith('SQLITE');
  if (isSqliteError) {
    logError('ERROR_DB', err, {
      route: req.originalUrl,
      method: req.method,
    });
  }

  const normalized = normalizeHttpError(err);
  if (normalized.status === 500 && !isSqliteError) {
    logError('ERROR_DB', err, {
      route: req.originalUrl,
      method: req.method,
      status: normalized.status,
    });
  }
  return fail(res, normalized.error, normalized.status);
});

app.use((req, res) => {
  return fail(res, createHttpError(404, 'NOT_FOUND', 'Not found.'), 404);
});

module.exports = app;
