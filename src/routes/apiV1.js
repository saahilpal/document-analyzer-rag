const express = require('express');
const fs = require('fs/promises');
const os = require('os');
const multer = require('multer');
const { z } = require('zod');
const {
  listSessions,
  searchSessionsByTitle,
  createSession,
  renameSession,
  getSessionMetadata,
  assertSessionExists,
  deleteSession,
} = require('../services/sessionService');
const {
  createUser,
  authenticateUser,
  createJWTAuthSession,
  deleteAuthSessionById,
  toPublicUser,
  requestOTP,
  verifyOTP,
  rotateRefreshToken,
  requestPasswordReset,
  executePasswordReset,
  activateUser,
  updateUserEmail,
} = require('../services/authService');
const { sendEmail } = require('../services/emailService');
const {
  createPdfRecord,
  updatePdfStorage,
  listPdfsBySession,
  assertPdfExists,
  deletePdfRecord,
  getPdfReadinessBySession,
} = require('../services/pdfRecordService');
const {
  uploadsRoot,
  sanitizeFilename,
  ensureTempUploadDir,
  inspectUploadedFile,
  saveUploadedFileById,
  removeStoredPdf,
  removeTempUpload,
} = require('../services/uploadService');
const {
  addJob,
  getJobForUser,
  getQueueState,
  getQueuePosition,
  removeJobsFromMemory,
} = require('../services/jobQueue');
const {
  runChatQuery,
  runChatQueryStream,
  shouldRunAsyncChat,
  normalizeResponseStyle,
} = require('../services/ragService');
const { addConversation, listSessionHistory, clearSessionHistory } = require('../services/chatHistoryService');
const { getMetrics, recordQuery } = require('../services/metricsService');
const rateLimiter = require('../middleware/rateLimiter');
const validateSchema = require('../middleware/validate');
const requireAuth = require('../middleware/requireAuth');
const { ok, fail } = require('./helpers');
const asyncHandler = require('../utils/asyncHandler');
const { createHttpError, normalizeHttpError } = require('../utils/errors');
const { logInfo, logError } = require('../utils/logger');

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      ensureTempUploadDir()
        .then((tempDir) => cb(null, tempDir))
        .catch((error) => cb(error));
    },
    filename(req, file, cb) {
      const timestamp = Date.now();
      const randomSuffix = Math.random().toString(16).slice(2, 10);
      cb(null, `${timestamp}_${randomSuffix}_${sanitizeFilename(file.originalname || 'upload.pdf')}`);
    },
  }),
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_FILE_SIZE_BYTES) || 50 * 1024 * 1024,
  },
});

const createSessionBodySchema = z.object({
  title: z.string().min(1).max(160),
});

const registerBodySchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(320),
  password: z.string().min(8).max(128),
});

const loginBodySchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(128),
});

const otpBodySchema = z.object({
  email: z.string().email().max(320),
});

const verifyOtpBodySchema = z.object({
  email: z.string().email().max(320),
  otp: z.string().min(6).max(6),
});

const refreshBodySchema = z.object({
  refreshToken: z.string().min(1),
});

const requestResetBodySchema = z.object({
  email: z.string().email().max(320),
});

const resetPasswordBodySchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

const changeEmailRequestSchema = z.object({
  newEmail: z.string().email().max(320),
});

const performEmailChangeSchema = z.object({
  newEmail: z.string().email().max(320),
  otp: z.string().min(6).max(6)
});

const chatBodySchema = z.object({
  message: z.string().min(1).max(10_000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string(),
  })).max(100).optional(),
  responseStyle: z.enum(['structured', 'plain']).optional(),
});

const renameSessionBodySchema = z.object({
  title: z.string().trim().min(1).max(60),
});

const sessionSearchQuerySchema = z.object({
  q: z.string().max(160).optional(),
});

const historyQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/)
    .optional(),
  offset: z
    .string()
    .regex(/^\d+$/)
    .optional(),
});

const strictReadLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 200 });
const writeLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 80 });
const uploadLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 16 });
const chatLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 30 });
const registerLimiter = rateLimiter({ windowMs: 15 * 60_000, maxRequests: 30 });
const loginLimiter = rateLimiter({ windowMs: 15 * 60_000, maxRequests: 20 });

function normalizeMulterError(error) {
  if (error?.name === 'MulterError') {
    throw createHttpError(
      400,
      error.code === 'LIMIT_FILE_SIZE' ? 'UPLOAD_TOO_LARGE' : 'UPLOAD_FAILED',
      error.code === 'LIMIT_FILE_SIZE'
        ? 'Uploaded file exceeds configured size limit.'
        : error.message || 'Upload failed.'
    );
  }
  if (error) {
    throw error;
  }
}

function parsePositiveInt(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw createHttpError(400, 'INVALID_PATH_PARAM', `${fieldName} must be a positive integer.`, {
      retryable: false,
    });
  }
  return parsed;
}

function validateHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((entry) => entry && (entry.role === 'user' || entry.role === 'assistant') && typeof entry.text === 'string')
    .map((entry) => ({ role: entry.role, text: entry.text.trim() }))
    .filter((entry) => entry.text.length > 0);
}

function normalizeOptionalTitle(title, fallback) {
  const normalized = String(title || '').trim();
  if (normalized) {
    return normalized;
  }
  return sanitizeFilename(fallback || 'uploaded').replace(/\.[a-z0-9]{1,12}$/i, '');
}

function shouldStreamChat(req) {
  const queryFlag = String(req.query.stream || '').toLowerCase() === 'true';
  const acceptHeader = String(req.headers.accept || '').toLowerCase();
  return queryFlag || acceptHeader.includes('text/event-stream');
}

function initSse(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
}

function writeSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function getClientMetadata(req) {
  return {
    deviceInfo: String(req.headers['user-agent'] || '').trim() || null,
    ipAddress: String(req.ip || '').trim() || null,
  };
}

router.post('/auth/register', registerLimiter, validateSchema(registerBodySchema), asyncHandler(async (req, res) => {
  const user = await createUser({
    name: req.body.name,
    email: req.body.email,
    password: req.body.password,
  });

  if (!user.isActive) {
    try {
      await requestOTP(user.email, 'register');
    } catch (err) {
      logError('ERROR_EMAIL', err, { route: '/auth/register' });
    }
  }

  return ok(res, { message: 'If account exists, email sent.' });
}));

router.post('/auth/send-otp', registerLimiter, validateSchema(otpBodySchema), asyncHandler(async (req, res) => {
  try {
    await requestOTP(req.body.email, 'register');
  } catch (err) {
    logError('ERROR_EMAIL', err, { route: '/auth/send-otp' });
  }
  return ok(res, { message: 'If account exists, email sent.' });
}));

router.post('/auth/verify-otp', registerLimiter, validateSchema(verifyOtpBodySchema), asyncHandler(async (req, res) => {
  await verifyOTP(req.body.email, 'register', req.body.otp);
  activateUser(req.body.email);
  try {
    await sendEmail('welcome', { to: req.body.email });
  } catch (err) {
    logError('ERROR_EMAIL', err, { route: '/auth/verify-otp' });
  }
  return ok(res, { message: 'Account verified successfully.' });
}));


router.post('/auth/login', loginLimiter, validateSchema(loginBodySchema), asyncHandler(async (req, res) => {
  const user = await authenticateUser({
    email: req.body.email,
    password: req.body.password,
    ipAddress: req.ip,
  });

  if (!user.isActive) {
    return fail(res, createHttpError(403, 'INACTIVE_ACCOUNT', 'Please verify your email address to log in.'), 403);
  }

  const { deviceInfo, ipAddress } = getClientMetadata(req);

  const authSession = createJWTAuthSession({
    userId: user.id,
    deviceInfo,
    ipAddress,
  });

  try {
    await sendEmail('alert', { to: user.email, ip: ipAddress, device: deviceInfo });
  } catch (err) { }

  return ok(res, {
    accessToken: authSession.accessToken,
    refreshToken: authSession.refreshToken,
    expiresAt: authSession.expiresAt,
    user: toPublicUser(user),
  });
}));

router.post('/auth/refresh', loginLimiter, validateSchema(refreshBodySchema), asyncHandler(async (req, res) => {
  const { deviceInfo, ipAddress } = getClientMetadata(req);
  const session = await rotateRefreshToken(req.body.refreshToken, ipAddress);

  return ok(res, {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresAt
  });
}));

router.post('/auth/request-reset', registerLimiter, validateSchema(requestResetBodySchema), asyncHandler(async (req, res) => {
  try {
    await requestPasswordReset(req.body.email);
  } catch (err) {
    logError('ERROR_EMAIL', err, { route: '/auth/request-reset' });
  }
  return ok(res, { message: 'If account exists, email sent.' });
}));

router.post('/auth/reset-password', registerLimiter, validateSchema(resetPasswordBodySchema), asyncHandler(async (req, res) => {
  await executePasswordReset(req.body.token, req.body.newPassword);
  return ok(res, { message: 'Password reset successfully. Please log in with your new password.' });
}));

router.get('/health', strictReadLimiter, (req, res) => {
  const queueState = getQueueState();
  const memoryUsage = process.memoryUsage();
  const cpuLoad = os.loadavg();

  return ok(res, {
    status: 'ok',
    service: 'Document-analyzer-rag Backend',
    uptime: process.uptime(),
    queueSize: queueState.pending + queueState.processing,
    memoryUsage: {
      rss: memoryUsage.rss,
      heapTotal: memoryUsage.heapTotal,
      heapUsed: memoryUsage.heapUsed,
      external: memoryUsage.external,
    },
    cpuLoad: {
      oneMinute: cpuLoad[0],
      fiveMinutes: cpuLoad[1],
      fifteenMinutes: cpuLoad[2],
    },
  });
});
router.get('/ping', strictReadLimiter, (req, res) => ok(res, { pong: true }));

router.use(requireAuth);

router.get('/auth/me', strictReadLimiter, (req, res) => {
  return ok(res, {
    id: req.user.id,
    name: req.user.name,
    email: req.user.email,
    created_at: req.user.createdAt,
    is_active: req.user.isActive
  });
});

router.post('/auth/change-email', writeLimiter, validateSchema(changeEmailRequestSchema), asyncHandler(async (req, res) => {
  try {
    await requestOTP(req.body.newEmail, 'change_email');
  } catch (err) {
    logError('ERROR_EMAIL', err, { route: '/auth/change-email' });
  }
  return ok(res, { message: 'If account exists, email sent.' });
}));

router.post('/auth/change-email/verify', writeLimiter, validateSchema(performEmailChangeSchema), asyncHandler(async (req, res) => {
  await verifyOTP(req.body.newEmail, 'change_email', req.body.otp);
  updateUserEmail(req.user.id, req.body.newEmail);
  return ok(res, { message: 'Email updated successfully.' });
}));

router.get('/auth/sessions', strictReadLimiter, asyncHandler(async (req, res) => {
  const db = require('../db/database');
  const sessions = db.prepare(`SELECT id, device_info, ip_address, created_at, last_used_at FROM auth_sessions WHERE user_id = ? ORDER BY last_used_at DESC`).all(req.user.id);
  return ok(res, { sessions });
}));

router.delete('/auth/sessions/:sessionId', writeLimiter, asyncHandler(async (req, res) => {
  const db = require('../db/database');
  const { sessionId } = req.params;

  // We ensure they can only delete their own sessions
  const session = db.prepare(`SELECT id FROM auth_sessions WHERE id = ? AND user_id = ?`).get(sessionId, req.user.id);
  if (!session) {
    throw createHttpError(404, 'NOT_FOUND', 'Session not found.');
  }

  deleteAuthSessionById(session.id);
  return ok(res, { deleted: true });
}));

router.delete('/auth/session', writeLimiter, (req, res) => {
  deleteAuthSessionById(req.authSession.id);
  return ok(res, { loggedOut: true });
});

router.get('/sessions', strictReadLimiter, (req, res) => ok(res, listSessions(req.user.id)));

router.post('/sessions', writeLimiter, validateSchema(createSessionBodySchema), (req, res) => {
  const title = req.body.title.trim();

  const session = createSession(req.user.id, title);
  return ok(res, session);
});

router.get('/sessions/search', strictReadLimiter, validateSchema(sessionSearchQuerySchema, 'query'), (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) {
    return ok(res, []);
  }
  return ok(res, searchSessionsByTitle(req.user.id, query, { limit: 50 }));
});

router.patch('/sessions/:sessionId', writeLimiter, validateSchema(renameSessionBodySchema), (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  const session = renameSession(sessionId, req.user.id, req.body.title);
  return ok(res, session);
});

router.get('/sessions/:sessionId/meta', strictReadLimiter, (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  return ok(res, getSessionMetadata(sessionId, req.user.id));
});

router.get('/sessions/:sessionId', strictReadLimiter, (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  const session = assertSessionExists(sessionId, req.user.id);
  const pdfs = listPdfsBySession(sessionId, req.user.id);
  return ok(res, { ...session, pdfs });
});

router.delete('/sessions/:sessionId', writeLimiter, asyncHandler(async (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  const result = deleteSession(sessionId, req.user.id);
  removeJobsFromMemory(result.deletedJobIds);

  for (const storagePath of result.deletedPdfPaths) {
    await removeStoredPdf(storagePath).catch((error) => {
      if (error?.code === 'ENOENT') {
        return;
      }
      logError('ERROR_UPLOAD', error, {
        route: '/api/v1/sessions/:sessionId',
        sessionId,
        stage: 'removeSessionPdfFile',
      });
    });
  }

  return ok(res, { deleted: true, id: result.id });
}));

router.post('/sessions/:sessionId/pdfs', uploadLimiter, (req, res, next) => {
  upload.single('file')(req, res, async (uploadErr) => {
    let tempFilePath = '';
    try {
      normalizeMulterError(uploadErr);
      const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
      assertSessionExists(sessionId, req.user.id);

      if (!req.file) {
        throw createHttpError(400, 'MISSING_UPLOAD_FILE', 'file is required as multipart form-data.');
      }
      tempFilePath = req.file.path;

      logInfo('UPLOAD_START', {
        route: '/api/v1/sessions/:sessionId/pdfs',
        sessionId,
        originalName: req.file.originalname,
        fileSize: req.file.size,
      });

      const detectedFile = await inspectUploadedFile(req.file);

      const pdf = createPdfRecord({
        userId: req.user.id,
        sessionId,
        title: normalizeOptionalTitle(req.body.title, req.file.originalname),
        filename: `pending.${detectedFile.extension}`,
        storagePath: '',
        type: detectedFile.fileType,
      });

      try {
        const { filename, storagePath } = await saveUploadedFileById({
          sessionId,
          pdfId: pdf.id,
          file: req.file,
          detectedFile,
        });

        updatePdfStorage(pdf.id, { filename, storagePath });
      } catch (error) {
        logError('ERROR_UPLOAD', error, {
          route: '/api/v1/sessions/:sessionId/pdfs',
          sessionId,
        });
        deletePdfRecord(pdf.id, req.user.id);
        throw error;
      }

      const indexJob = addJob({
        type: 'indexPdf',
        userId: req.user.id,
        pdfId: pdf.id,
        maxRetries: 3,
      });

      return ok(res, {
        pdfId: pdf.id,
        sessionId,
        title: pdf.title,
        status: 'processing',
        jobId: indexJob.id,
        progress: indexJob.progress,
        stage: indexJob.stage,
        queuePosition: getQueuePosition(indexJob.id),
      }, 202);
    } catch (error) {
      await removeTempUpload(tempFilePath).catch((cleanupError) => {
        logError('ERROR_UPLOAD', cleanupError, {
          route: '/api/v1/sessions/:sessionId/pdfs',
          stage: 'cleanupTempUpload',
        });
      });
      return next(error);
    }
  });
});

router.get('/pdfs/:pdfId', strictReadLimiter, (req, res) => {
  const pdfId = parsePositiveInt(req.params.pdfId, 'pdfId');
  const pdf = assertPdfExists(pdfId, req.user.id);
  return ok(res, pdf);
});

router.delete('/pdfs/:pdfId', writeLimiter, asyncHandler(async (req, res) => {
  const pdfId = parsePositiveInt(req.params.pdfId, 'pdfId');
  const removeFile = String(req.query.removeFile || 'false').toLowerCase() === 'true';

  const pdf = assertPdfExists(pdfId, req.user.id);
  if (removeFile) {
    try {
      await removeStoredPdf(pdf.path);
    } catch (error) {
      logError('ERROR_UPLOAD', error, {
        route: '/api/v1/pdfs/:pdfId',
        pdfId,
      });
    }
  }

  const result = deletePdfRecord(pdfId, req.user.id);
  return ok(res, result);
}));

router.get('/sessions/:sessionId/pdfs', strictReadLimiter, (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  assertSessionExists(sessionId, req.user.id);
  return ok(res, listPdfsBySession(sessionId, req.user.id));
});

router.post('/sessions/:sessionId/chat', chatLimiter, validateSchema(chatBodySchema), asyncHandler(async (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  const session = assertSessionExists(sessionId, req.user.id);
  const message = req.body.message.trim();
  const { history } = req.body;
  const responseStyle = normalizeResponseStyle(req.body.responseStyle);

  const normalizedHistory = validateHistory(history);
  const readiness = getPdfReadinessBySession(sessionId, req.user.id);
  if (readiness.uploaded === 0 || readiness.indexed === 0 || readiness.processing > 0 || readiness.failed > 0) {
    return fail(
      res,
      createHttpError(400, 'PDF_NOT_READY', 'Documents still processing or failed indexing.', {
        retryable: readiness.processing > 0,
      }),
      400
    );
  }

  logInfo('CHAT_REQUEST', {
    route: '/api/v1/sessions/:sessionId/chat',
    sessionId,
    messageLength: message.length,
  });

  if (shouldStreamChat(req)) {
    initSse(res);
    let clientDisconnected = false;
    req.on('aborted', () => {
      clientDisconnected = true;
    });
    res.on('close', () => {
      if (!res.writableEnded) {
        clientDisconnected = true;
      }
    });

    const emitEvent = (event, payload) => {
      if (clientDisconnected || res.writableEnded) {
        return;
      }
      writeSseEvent(res, event, payload);
    };

    emitEvent('ready', {
      ok: true,
      data: {
        sessionId,
        status: 'streaming',
      },
    });

    try {
      const response = await runChatQueryStream({
        sessionId,
        message,
        history: normalizedHistory,
        responseStyle,
      }, {
        onProgress: ({ stage, progress }) => {
          emitEvent('progress', {
            ok: true,
            data: { stage, progress },
          });
        },
        onToken: (token) => {
          emitEvent('token', {
            ok: true,
            data: { token },
          });
        },
      });

      if (!clientDisconnected) {
        try {
          addConversation({
            userId: req.user.id,
            sessionId,
            userText: message,
            assistantText: response.answer,
          });
        } catch (error) {
          logError('ERROR_DB', error, {
            route: '/api/v1/sessions/:sessionId/chat',
            sessionId,
            stage: 'streamPersistConversation',
          });
        }
      }

      emitEvent('done', {
        ok: true,
        data: {
          answer: response.answer,
          formattedAnswer: response.formattedAnswer,
          responseSchema: response.responseSchema,
          responseStyle: response.responseStyle,
          sources: response.sources,
          usedChunksCount: response.usedChunksCount,
          sessionTitle: session.title,
        },
      });
    } catch (error) {
      const normalized = normalizeHttpError(error);
      emitEvent('error', {
        ok: false,
        error: normalized.error,
      });
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
    return;
  }

  if (shouldRunAsyncChat({ sessionId, history: normalizedHistory })) {
    const job = addJob({
      type: 'chatQuery',
      userId: req.user.id,
      sessionId,
      message,
      history: normalizedHistory,
      responseStyle,
      maxRetries: 1,
    });

    return ok(res, {
      jobId: job.id,
      sessionId,
      status: 'processing',
      responseStyle,
      progress: job.progress,
      stage: job.stage,
      queuePosition: getQueuePosition(job.id),
    }, 202);
  }

  const startedAt = Date.now();
  const response = await runChatQuery({
    sessionId,
    message,
    history: normalizedHistory,
    responseStyle,
  });
  const durationMs = Date.now() - startedAt;
  recordQuery({ queryTimeMs: durationMs });
  try {
    addConversation({
      userId: req.user.id,
      sessionId,
      userText: message,
      assistantText: response.answer,
    });
  } catch (error) {
    logError('ERROR_DB', error, {
      route: '/api/v1/sessions/:sessionId/chat',
      sessionId,
    });
  }

  return ok(res, {
    answer: response.answer,
    formattedAnswer: response.formattedAnswer,
    responseSchema: response.responseSchema,
    responseStyle: response.responseStyle,
    sources: response.sources,
    usedChunksCount: response.usedChunksCount,
    sessionTitle: session.title,
  });
}));

router.get('/jobs/:jobId', strictReadLimiter, (req, res) => {
  const job = getJobForUser(req.params.jobId, req.user.id);
  if (!job) {
    throw createHttpError(400, 'UNKNOWN_JOB_ID', 'jobId does not exist.');
  }

  return ok(res, {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    queuePosition: getQueuePosition(job.id),
    attempts: job.attempts,
    result: job.result,
    error: job.error,
    metrics: job.metrics,
  });
});

router.get('/sessions/:sessionId/history', strictReadLimiter, validateSchema(historyQuerySchema, 'query'), (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  assertSessionExists(sessionId, req.user.id);
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
  const offset = req.query.offset !== undefined ? Number(req.query.offset) : undefined;
  return ok(res, listSessionHistory(sessionId, req.user.id, { limit, offset }));
});

router.delete('/sessions/:sessionId/history', writeLimiter, (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  assertSessionExists(sessionId, req.user.id);
  return ok(res, clearSessionHistory(sessionId, req.user.id));
});

router.get('/admin/queue', strictReadLimiter, (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    throw createHttpError(400, 'ADMIN_DISABLED', 'Admin queue endpoint is disabled in production.');
  }

  return ok(res, {
    queue: getQueueState(),
    metrics: getMetrics(),
  });
});

router.post('/admin/reset', writeLimiter, asyncHandler(async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    throw createHttpError(400, 'ADMIN_DISABLED', 'Admin reset endpoint is disabled in production.');
  }

  await fs.rm(uploadsRoot, { recursive: true, force: true }).catch((error) => {
    logError('ERROR_UPLOAD', error, {
      route: '/api/v1/admin/reset',
    });
  });
  return ok(res, { reset: true });
}));

module.exports = router;
