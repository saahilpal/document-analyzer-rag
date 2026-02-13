const express = require('express');
const fs = require('fs/promises');
const multer = require('multer');
const {
  listSessions,
  createSession,
  assertSessionExists,
  deleteSession,
} = require('../services/sessionService');
const {
  createPdfRecord,
  updatePdfStorage,
  listPdfsBySession,
  assertPdfExists,
  deletePdfRecord,
  getPdfReadinessBySession,
} = require('../services/pdfRecordService');
const { sanitizeFilename, saveUploadedPdfById, removeStoredPdf } = require('../services/uploadService');
const { addJob, getJob, getQueueState } = require('../services/jobQueue');
const { runChatQuery, shouldRunAsyncChat, generateSessionQuiz } = require('../services/ragService');
const { addMessage, listSessionHistory, clearSessionHistory } = require('../services/chatHistoryService');
const { getRecentContextTextsBySession } = require('../services/vectorService');
const { getMetrics, recordQuery } = require('../services/metricsService');
const { ok } = require('./helpers');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_FILE_SIZE_BYTES) || 50 * 1024 * 1024,
  },
});

function normalizeMulterError(error) {
  if (error?.name === 'MulterError') {
    const err = new Error(
      error.code === 'LIMIT_FILE_SIZE'
        ? 'Uploaded file exceeds configured size limit.'
        : error.message || 'Upload failed.'
    );
    err.statusCode = 400;
    throw err;
  }
  if (error) {
    throw error;
  }
}

function parsePositiveInt(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`${fieldName} must be a positive integer.`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function validateHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter((entry) => entry && (entry.role === 'user' || entry.role === 'assistant') && typeof entry.text === 'string')
    .map((entry) => ({ role: entry.role, text: entry.text }));
}

router.get('/health', (req, res) => ok(res, { status: 'ok', service: 'StudyRAG Backend' }));
router.get('/ping', (req, res) => ok(res, { pong: true }));

router.get('/sessions', (req, res) => ok(res, listSessions()));

router.post('/sessions', (req, res) => {
  const { title } = req.body;
  if (!title || typeof title !== 'string') {
    const error = new Error('title is required and must be a string.');
    error.statusCode = 400;
    throw error;
  }

  const session = createSession(title);
  return ok(res, session);
});

router.get('/sessions/:sessionId', (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  const session = assertSessionExists(sessionId);
  const pdfs = listPdfsBySession(sessionId);
  return ok(res, { ...session, pdfs });
});

router.delete('/sessions/:sessionId', (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  const result = deleteSession(sessionId);
  return ok(res, result);
});

router.post('/sessions/:sessionId/pdfs', (req, res, next) => {
  upload.single('file')(req, res, async (uploadErr) => {
    try {
      normalizeMulterError(uploadErr);
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  assertSessionExists(sessionId);

  if (!req.file) {
    const error = new Error('file is required as multipart form-data.');
    error.statusCode = 400;
    throw error;
  }

  // eslint-disable-next-line no-console
  console.info(`UPLOAD_START sessionId=${sessionId} originalName=${req.file.originalname} size=${req.file.size}`);

  const pdf = createPdfRecord({
    sessionId,
    title: req.body.title || sanitizeFilename(req.file.originalname || 'uploaded.pdf').replace(/\.pdf$/i, ''),
    filename: 'pending.pdf',
    storagePath: '',
    type: 'pdf',
  });

  try {
    const { filename, storagePath } = await saveUploadedPdfById({
      sessionId,
      pdfId: pdf.id,
      file: req.file,
    });

    updatePdfStorage(pdf.id, { filename, storagePath });
  } catch (error) {
    deletePdfRecord(pdf.id);
    throw error;
  }

  addJob({
    type: 'indexPdf',
    pdfId: pdf.id,
    maxRetries: 3,
  });

  // eslint-disable-next-line no-console
  console.info(`UPLOAD_DONE sessionId=${sessionId} pdfId=${pdf.id} status=processing`);

  return ok(res, {
    pdfId: pdf.id,
    sessionId,
    title: pdf.title,
    status: 'processing',
  }, 202);
    } catch (error) {
      return next(error);
    }
  });
});

router.get('/pdfs/:pdfId', (req, res) => {
  const pdfId = parsePositiveInt(req.params.pdfId, 'pdfId');
  const pdf = assertPdfExists(pdfId);
  return ok(res, pdf);
});

router.delete('/pdfs/:pdfId', async (req, res) => {
  const pdfId = parsePositiveInt(req.params.pdfId, 'pdfId');
  const removeFile = String(req.query.removeFile || 'false').toLowerCase() === 'true';

  const pdf = assertPdfExists(pdfId);
  if (removeFile) {
    await removeStoredPdf(pdf.path).catch(() => null);
  }

  const result = deletePdfRecord(pdfId);
  return ok(res, result);
});

router.get('/sessions/:sessionId/pdfs', (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  assertSessionExists(sessionId);
  return ok(res, listPdfsBySession(sessionId));
});

router.post('/sessions/:sessionId/chat', async (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  const session = assertSessionExists(sessionId);
  const { message, history } = req.body;

  if (!message || typeof message !== 'string') {
    const error = new Error('message is required and must be a string.');
    error.statusCode = 400;
    throw error;
  }

  const normalizedHistory = validateHistory(history);
  const readiness = getPdfReadinessBySession(sessionId);
  if (readiness.uploaded === 0 || readiness.indexed === 0 || readiness.processing > 0 || readiness.failed > 0) {
    return res.status(400).json({
      ok: false,
      error: 'PDF_NOT_READY',
    });
  }

  // eslint-disable-next-line no-console
  console.info(`CHAT_REQUEST sessionId=${sessionId} messageLength=${message.length}`);

  if (shouldRunAsyncChat({ sessionId, history: normalizedHistory })) {
    const job = addJob({
      type: 'chatQuery',
      sessionId,
      message,
      history: normalizedHistory,
      maxRetries: 1,
    });

    return ok(res, {
      jobId: job.id,
      sessionId,
      status: 'processing',
    }, 202);
  }

  const startedAt = Date.now();
  const response = await runChatQuery({
    sessionId,
    message,
    history: normalizedHistory,
  });
  recordQuery({ queryTimeMs: Date.now() - startedAt });
  // eslint-disable-next-line no-console
  console.info(`CHAT_RESPONSE_TIME sessionId=${sessionId} durationMs=${Date.now() - startedAt}`);

  addMessage({ sessionId, role: 'user', text: message });
  addMessage({
    sessionId,
    role: 'assistant',
    text: response.answer,
  });

  return ok(res, {
    answer: response.answer,
    sources: response.sources,
    usedChunksCount: response.usedChunksCount,
    sessionTitle: session.title,
  });
});

router.get('/jobs/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    const error = new Error('jobId does not exist.');
    error.statusCode = 400;
    throw error;
  }

  return ok(res, {
    id: job.id,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    result: job.result,
    error: job.error,
    metrics: job.metrics,
  });
});

router.get('/sessions/:sessionId/history', (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  assertSessionExists(sessionId);
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
  const offset = req.query.offset !== undefined ? Number(req.query.offset) : undefined;
  return ok(res, listSessionHistory(sessionId, { limit, offset }));
});

router.delete('/sessions/:sessionId/history', (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  assertSessionExists(sessionId);
  return ok(res, clearSessionHistory(sessionId));
});

router.post('/sessions/:sessionId/quiz', async (req, res) => {
  const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
  const session = assertSessionExists(sessionId);

  const difficulty = String(req.body.difficulty || 'medium').toLowerCase();
  const count = Number(req.body.count || 5);
  if (!['easy', 'medium', 'hard'].includes(difficulty)) {
    const error = new Error('difficulty must be one of: easy, medium, hard.');
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    const error = new Error('count must be an integer between 1 and 20.');
    error.statusCode = 400;
    throw error;
  }

  const contextText = getRecentContextTextsBySession(sessionId, 24).join('\n\n');
  const quiz = await generateSessionQuiz({
    sessionTitle: session.title,
    contextText,
    difficulty,
    count,
  });

  return ok(res, quiz);
});

router.get('/admin/queue', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    const error = new Error('Admin queue endpoint is disabled in production.');
    error.statusCode = 400;
    throw error;
  }

  return ok(res, {
    queue: getQueueState(),
    metrics: getMetrics(),
  });
});

router.post('/admin/reset', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    const error = new Error('Admin reset endpoint is disabled in production.');
    error.statusCode = 400;
    throw error;
  }

  await fs.rm('data/uploads', { recursive: true, force: true }).catch(() => null);
  return ok(res, { reset: true });
});

module.exports = router;
