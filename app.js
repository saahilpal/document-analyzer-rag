require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

require('./db/database');

const apiV1Route = require('./routes/apiV1');
const legacyRoute = require('./routes/legacy');
const rateLimiter = require('./middleware/rateLimiter');

const app = express();

const allowedOrigins = [
  /^http:\/\/localhost(:\d+)?$/i,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/i,
  /^http:\/\/10\.0\.2\.2(:\d+)?$/i,
  /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/i,
  /^http:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/i,
  /^http:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+(:\d+)?$/i,
];

function isAllowedOrigin(origin) {
  if (!origin) {
    return true;
  }
  return allowedOrigins.some((rule) => rule.test(origin));
}

app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS origin not allowed.'));
  },
}));
app.use(morgan('dev'));
app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => {
  res.status(200).json({ message: 'StudyRAG backend running' });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'StudyRAG Backend' });
});

// Authentication has been intentionally removed in this phase to support a local-first academic deployment.
// The backend is structured to allow seamless reintroduction of JWT-based authentication in future iterations without architectural changes.
app.use('/api/v1', rateLimiter({ windowMs: 60_000, maxRequests: 100 }), apiV1Route);

// Transitional aliases for one release.
app.use(legacyRoute);

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  const status = err.statusCode === 400 ? 400 : (err.statusCode === 429 ? 429 : 500);
  return res.status(status).json({
    error: status === 500 ? 'Internal Server Error' : 'Request Error',
    message: err.message || 'Something went wrong.',
  });
});

module.exports = app;
