const path = require('path');
const db = require('../db/database');
const { invalidatePdfCache } = require('./vectorService');

const insertPdfStmt = db.prepare(`
  INSERT INTO pdfs (user_id, sessionId, title, filename, path, type, status, indexedChunks, createdAt)
  VALUES (@userId, @sessionId, @title, @filename, @path, @type, @status, @indexedChunks, @createdAt)
`);

const getPdfStmt = db.prepare(`
  SELECT id, sessionId, title, filename, path, type, status, indexedChunks, createdAt
  FROM pdfs
  WHERE id = ?
`);

const getPdfByUserStmt = db.prepare(`
  SELECT id, sessionId, title, filename, path, type, status, indexedChunks, createdAt
  FROM pdfs
  WHERE id = ? AND user_id = ?
`);

const listPdfsBySessionStmt = db.prepare(`
  SELECT id, sessionId, title, filename, path, type, status, indexedChunks, createdAt
  FROM pdfs
  WHERE sessionId = ? AND user_id = ?
  ORDER BY id ASC
`);

const updatePdfStatusStmt = db.prepare(`
  UPDATE pdfs
  SET status = @status,
      indexedChunks = @indexedChunks
  WHERE id = @id
`);

const updatePdfStorageStmt = db.prepare(`
  UPDATE pdfs
  SET filename = @filename,
      path = @path
  WHERE id = @id
`);

const countIndexedPdfsBySessionStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM pdfs
  WHERE sessionId = ? AND user_id = ? AND status = 'indexed' AND indexedChunks > 0
`);

const countPdfsBySessionStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM pdfs
  WHERE sessionId = ? AND user_id = ?
`);

const countPdfsBySessionAndStatusStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM pdfs
  WHERE sessionId = ? AND user_id = ? AND status = ?
`);

const deletePdfStmt = db.prepare(`
  DELETE FROM pdfs
  WHERE id = ? AND user_id = ?
`);

const deleteChunksByPdfStmt = db.prepare(`
  DELETE FROM chunks
  WHERE pdfId = ?
`);

function normalizeUserId(userId) {
  const normalizedUserId = Number(userId);
  if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) {
    const error = new Error('userId is required and must be a positive integer.');
    error.statusCode = 400;
    throw error;
  }
  return normalizedUserId;
}

function createPdfRecord({ userId, sessionId, title, filename = '', storagePath = '', type = 'pdf' }) {
  const normalizedUserId = normalizeUserId(userId);

  const createdAt = new Date().toISOString();
  const normalizedTitle = title ? title.trim() : path.basename(filename, path.extname(filename));

  const result = insertPdfStmt.run({
    userId: normalizedUserId,
    sessionId,
    title: normalizedTitle || filename,
    filename,
    path: storagePath,
    type: type.toLowerCase(),
    status: 'processing',
    indexedChunks: 0,
    createdAt,
  });

  return getPdfById(Number(result.lastInsertRowid), normalizedUserId);
}

function getPdfById(pdfId, userId = null) {
  if (Number.isInteger(Number(userId)) && Number(userId) > 0) {
    return getPdfByUserStmt.get(pdfId, Number(userId)) || null;
  }
  return getPdfStmt.get(pdfId) || null;
}

function listPdfsBySession(sessionId, userId) {
  return listPdfsBySessionStmt.all(sessionId, normalizeUserId(userId));
}

function updatePdfStorage(pdfId, { filename, storagePath }) {
  updatePdfStorageStmt.run({
    id: pdfId,
    filename,
    path: storagePath,
  });
  return getPdfById(pdfId);
}

function assertPdfExists(pdfId, userId) {
  const pdf = getPdfById(pdfId, normalizeUserId(userId));
  if (!pdf) {
    const error = new Error('pdfId does not exist.');
    error.statusCode = 400;
    throw error;
  }
  return pdf;
}

function markPdfIndexed(pdfId, indexedChunks) {
  updatePdfStatusStmt.run({ id: pdfId, status: 'indexed', indexedChunks });
}

function markPdfFailed(pdfId) {
  updatePdfStatusStmt.run({ id: pdfId, status: 'failed', indexedChunks: 0 });
}

function deletePdfRecord(pdfId, userId) {
  const normalizedUserId = normalizeUserId(userId);
  assertPdfExists(pdfId, normalizedUserId);
  const remove = db.transaction((id, ownerId) => {
    invalidatePdfCache(id);
    deleteChunksByPdfStmt.run(id);
    deletePdfStmt.run(id, ownerId);
  });
  remove(pdfId, normalizedUserId);
  return { deleted: true, id: pdfId };
}

function getIndexedPdfCountBySession(sessionId, userId) {
  return countIndexedPdfsBySessionStmt.get(sessionId, normalizeUserId(userId)).count;
}

function getPdfReadinessBySession(sessionId, userId) {
  const normalizedUserId = normalizeUserId(userId);
  const uploaded = countPdfsBySessionStmt.get(sessionId, normalizedUserId).count;
  const indexed = getIndexedPdfCountBySession(sessionId, normalizedUserId);
  const processing = countPdfsBySessionAndStatusStmt.get(sessionId, normalizedUserId, 'processing').count;
  const failed = countPdfsBySessionAndStatusStmt.get(sessionId, normalizedUserId, 'failed').count;

  return {
    uploaded,
    indexed,
    processing,
    failed,
  };
}

module.exports = {
  createPdfRecord,
  updatePdfStorage,
  getPdfById,
  listPdfsBySession,
  assertPdfExists,
  markPdfIndexed,
  markPdfFailed,
  deletePdfRecord,
  getIndexedPdfCountBySession,
  getPdfReadinessBySession,
};
