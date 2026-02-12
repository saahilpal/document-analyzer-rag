const db = require('../db/database');

const insertMessageStmt = db.prepare(`
  INSERT INTO chat_history (sessionId, role, text, metadata, createdAt)
  VALUES (@sessionId, @role, @text, @metadata, @createdAt)
`);

const listMessagesStmt = db.prepare(`
  SELECT id, role, text, createdAt
  FROM chat_history
  WHERE sessionId = ?
  ORDER BY id ASC
`);

const deleteMessagesStmt = db.prepare(`
  DELETE FROM chat_history
  WHERE sessionId = ?
`);

function addMessage({ sessionId, role, text, metadata = null }) {
  const createdAt = new Date().toISOString();
  insertMessageStmt.run({
    sessionId,
    role,
    text,
    metadata: metadata ? JSON.stringify(metadata) : null,
    createdAt,
  });
}

function listSessionHistory(sessionId) {
  return listMessagesStmt.all(sessionId);
}

function clearSessionHistory(sessionId) {
  deleteMessagesStmt.run(sessionId);
  return { cleared: true };
}

module.exports = {
  addMessage,
  listSessionHistory,
  clearSessionHistory,
};
