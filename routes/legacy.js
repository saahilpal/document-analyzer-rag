const path = require('path');
const express = require('express');
const {
  listSessions,
  createSession,
  assertSessionExists,
  deleteSession,
  touchSession,
} = require('../services/sessionService');
const {
  createPdfRecord,
  listPdfsBySession,
  assertPdfExists,
  deletePdfRecord,
} = require('../services/pdfRecordService');
const { uploadsRoot } = require('../services/uploadService');
const { addJob } = require('../services/jobQueue');
const { runChatQuery, generateSessionQuiz } = require('../services/ragService');
const { addMessage } = require('../services/chatHistoryService');
const { getRecentContextTextsBySession } = require('../services/vectorService');
const { setDeprecationHeaders } = require('./helpers');

const router = express.Router();

function parseId(value, fieldName) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error(`${fieldName} must be a positive integer.`);
    error.statusCode = 400;
    throw error;
  }
  return id;
}

router.get('/subjects', (req, res) => {
  setDeprecationHeaders(res, '/api/v1/sessions');
  const sessions = listSessions().map((session) => ({ id: session.id, name: session.title }));
  return res.status(200).json(sessions);
});

router.post('/subjects', (req, res) => {
  setDeprecationHeaders(res, '/api/v1/sessions');
  const { name } = req.body;
  if (!name || typeof name !== 'string') {
    const error = new Error('name is required and must be a string.');
    error.statusCode = 400;
    throw error;
  }

  const created = createSession(name);
  return res.status(200).json({ id: created.id, name: created.title });
});

router.delete('/subjects/:id', (req, res) => {
  setDeprecationHeaders(res, '/api/v1/sessions/:sessionId');
  const sessionId = parseId(req.params.id, 'id');
  return res.status(200).json(deleteSession(sessionId));
});

router.get('/subjects/:subjectId/documents', (req, res) => {
  setDeprecationHeaders(res, '/api/v1/sessions/:sessionId/pdfs');
  const sessionId = parseId(req.params.subjectId, 'subjectId');
  assertSessionExists(sessionId);
  const docs = listPdfsBySession(sessionId).map((pdf) => ({
    id: pdf.id,
    title: pdf.title,
    type: pdf.type,
  }));
  return res.status(200).json(docs);
});

router.post('/documents', (req, res) => {
  setDeprecationHeaders(res, '/api/v1/sessions/:sessionId/pdfs');

  const sessionId = parseId(req.body.subjectId, 'subjectId');
  assertSessionExists(sessionId);

  const title = String(req.body.title || '').trim();
  const type = String(req.body.type || '').toLowerCase();
  const relativePath = String(req.body.path || '').trim();

  if (!title || !type || !relativePath) {
    const error = new Error('subjectId, title, type, and path are required.');
    error.statusCode = 400;
    throw error;
  }

  if (path.isAbsolute(relativePath)) {
    const error = new Error('Legacy path must be relative under data/uploads.');
    error.statusCode = 400;
    throw error;
  }

  const resolved = path.resolve(uploadsRoot, relativePath);
  const uploadsRootResolved = path.resolve(uploadsRoot);
  if (!resolved.startsWith(uploadsRootResolved)) {
    const error = new Error('Legacy path is outside allowed uploads directory.');
    error.statusCode = 400;
    throw error;
  }

  const filename = path.basename(resolved);
  const pdf = createPdfRecord({
    sessionId,
    title,
    filename,
    storagePath: resolved,
    type,
  });

  addJob({
    type: 'indexPdf',
    pdfId: pdf.id,
    maxRetries: 1,
  });

  touchSession(sessionId);

  return res.status(200).json({
    id: pdf.id,
    subjectId: pdf.sessionId,
    title: pdf.title,
    type: pdf.type,
    path: pdf.path,
    status: pdf.status,
  });
});

router.delete('/documents/:id', (req, res) => {
  setDeprecationHeaders(res, '/api/v1/pdfs/:pdfId');
  const pdfId = parseId(req.params.id, 'id');
  const pdf = assertPdfExists(pdfId);
  deletePdfRecord(pdfId);
  touchSession(pdf.sessionId);
  return res.status(200).json({ deleted: true, id: pdfId });
});

router.post('/rag/query', async (req, res) => {
  setDeprecationHeaders(res, '/api/v1/sessions/:sessionId/chat');
  const sessionId = parseId(req.body.subjectId, 'subjectId');
  assertSessionExists(sessionId);

  const question = String(req.body.question || '').trim();
  if (!question) {
    const error = new Error('question is required.');
    error.statusCode = 400;
    throw error;
  }

  const response = await runChatQuery({
    sessionId,
    message: question,
    history: Array.isArray(req.body.history) ? req.body.history : [],
  });

  addMessage({ sessionId, role: 'user', text: question });
  addMessage({ sessionId, role: 'assistant', text: response.answer, metadata: { sources: response.sources } });
  touchSession(sessionId);

  return res.status(200).json({ answer: response.answer });
});

router.post('/rag/quiz', async (req, res) => {
  setDeprecationHeaders(res, '/api/v1/sessions/:sessionId/quiz');
  const sessionId = parseId(req.body.subjectId, 'subjectId');
  const session = assertSessionExists(sessionId);

  const difficulty = String(req.body.difficulty || 'medium').toLowerCase();
  const count = Number(req.body.count || req.body.numQuestions || 5);
  const contextText = getRecentContextTextsBySession(sessionId, 24).join('\n\n');

  const quiz = await generateSessionQuiz({
    sessionTitle: session.title,
    contextText,
    difficulty,
    count,
  });

  return res.status(200).json(quiz);
});

module.exports = router;
