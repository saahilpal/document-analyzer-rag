const path = require('path');
const db = require('../db/database');

const insertPdfStmt = db.prepare(`
  INSERT INTO pdfs (sessionId, title, filename, path, type, status, indexedChunks, createdAt)
  VALUES (@sessionId, @title, @filename, @path, @type, @status, @indexedChunks, @createdAt)
`);

const getPdfStmt = db.prepare(`
  SELECT id, sessionId, title, filename, path, type, status, indexedChunks, createdAt
  FROM pdfs
  WHERE id = ?
`);

const listPdfsBySessionStmt = db.prepare(`
  SELECT id, sessionId, title, filename, path, type, status, indexedChunks, createdAt
  FROM pdfs
  WHERE sessionId = ?
  ORDER BY id ASC
`);

const updatePdfStatusStmt = db.prepare(`
  UPDATE pdfs
  SET status = @status,
      indexedChunks = @indexedChunks
  WHERE id = @id
`);

const deletePdfStmt = db.prepare(`
  DELETE FROM pdfs
  WHERE id = ?
`);

const deleteChunksByPdfStmt = db.prepare(`
  DELETE FROM chunks
  WHERE pdfId = ?
`);

function createPdfRecord({ sessionId, title, filename, storagePath, type = 'pdf' }) {
  const createdAt = new Date().toISOString();
  const normalizedTitle = title ? title.trim() : path.basename(filename, path.extname(filename));

  const result = insertPdfStmt.run({
    sessionId,
    title: normalizedTitle || filename,
    filename,
    path: storagePath,
    type: type.toLowerCase(),
    status: 'processing',
    indexedChunks: 0,
    createdAt,
  });

  return getPdfById(Number(result.lastInsertRowid));
}

function getPdfById(pdfId) {
  return getPdfStmt.get(pdfId) || null;
}

function listPdfsBySession(sessionId) {
  return listPdfsBySessionStmt.all(sessionId);
}

function assertPdfExists(pdfId) {
  const pdf = getPdfById(pdfId);
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

function deletePdfRecord(pdfId) {
  assertPdfExists(pdfId);
  const remove = db.transaction((id) => {
    deleteChunksByPdfStmt.run(id);
    deletePdfStmt.run(id);
  });
  remove(pdfId);
  return { deleted: true, id: pdfId };
}

module.exports = {
  createPdfRecord,
  getPdfById,
  listPdfsBySession,
  assertPdfExists,
  markPdfIndexed,
  markPdfFailed,
  deletePdfRecord,
};
