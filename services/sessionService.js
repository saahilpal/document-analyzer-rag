const db = require('../db/database');

const listSessionsStmt = db.prepare(`
  SELECT
    s.id,
    s.title,
    s.createdAt,
    s.updatedAt,
    (
      SELECT COUNT(*)
      FROM pdfs p
      WHERE p.sessionId = s.id
    ) AS pdfCount
  FROM sessions s
  ORDER BY s.updatedAt DESC, s.id DESC
`);

const insertSessionStmt = db.prepare(`
  INSERT INTO sessions (title, createdAt, updatedAt)
  VALUES (@title, @createdAt, @updatedAt)
`);

const getSessionStmt = db.prepare(`
  SELECT id, title, createdAt, updatedAt
  FROM sessions
  WHERE id = ?
`);

const touchSessionStmt = db.prepare(`
  UPDATE sessions
  SET updatedAt = @updatedAt
  WHERE id = @id
`);

const deleteSessionStmt = db.prepare(`
  DELETE FROM sessions
  WHERE id = ?
`);

const deleteSessionPdfsStmt = db.prepare(`
  DELETE FROM pdfs
  WHERE sessionId = ?
`);

const deleteSessionChunksStmt = db.prepare(`
  DELETE FROM chunks
  WHERE sessionId = ?
`);

const deleteSessionHistoryStmt = db.prepare(`
  DELETE FROM chat_history
  WHERE sessionId = ?
`);

function listSessions() {
  return listSessionsStmt.all();
}

function getSessionById(sessionId) {
  return getSessionStmt.get(sessionId) || null;
}

function createSession(title) {
  const now = new Date().toISOString();
  const result = insertSessionStmt.run({
    title: title.trim(),
    createdAt: now,
    updatedAt: now,
  });

  return getSessionById(Number(result.lastInsertRowid));
}

function touchSession(sessionId) {
  touchSessionStmt.run({ id: sessionId, updatedAt: new Date().toISOString() });
}

function assertSessionExists(sessionId) {
  const session = getSessionById(sessionId);
  if (!session) {
    const error = new Error('sessionId does not exist.');
    error.statusCode = 400;
    throw error;
  }
  return session;
}

function deleteSession(sessionId) {
  assertSessionExists(sessionId);

  const remove = db.transaction((id) => {
    deleteSessionHistoryStmt.run(id);
    deleteSessionChunksStmt.run(id);
    deleteSessionPdfsStmt.run(id);
    deleteSessionStmt.run(id);
  });

  remove(sessionId);
  return { deleted: true, id: sessionId };
}

module.exports = {
  listSessions,
  createSession,
  getSessionById,
  assertSessionExists,
  touchSession,
  deleteSession,
};
