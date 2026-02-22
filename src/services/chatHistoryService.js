const db = require('../db/database');
const ALLOWED_ROLES = new Set(['user', 'assistant', 'system']);

const insertMessageStmt = db.prepare(`
  INSERT INTO chat_messages (user_id, sessionId, role, text, createdAt)
  VALUES (@userId, @sessionId, @role, @text, @createdAt)
`);

const updateSessionMessageMetadataStmt = db.prepare(`
  UPDATE sessions
  SET last_message_at = @createdAt,
      last_message_preview = @lastMessagePreview
  WHERE id = @sessionId AND user_id = @userId
`);

const listMessagesStmt = db.prepare(`
  SELECT
    id,
    role,
    text,
    COALESCE(NULLIF(createdAt, ''), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS createdAt
  FROM chat_messages
  WHERE sessionId = @sessionId AND user_id = @userId
  ORDER BY createdAt ASC, id ASC
  LIMIT @limit
  OFFSET @offset
`);

const deleteMessagesStmt = db.prepare(`
  DELETE FROM chat_messages
  WHERE sessionId = ? AND user_id = ?
`);

const clearSessionMessageMetadataStmt = db.prepare(`
  UPDATE sessions
  SET last_message_at = NULL,
      last_message_preview = NULL
  WHERE id = ? AND user_id = ?
`);

const addMessageTx = db.transaction(({ userId, sessionId, role, text, createdAt }) => {
  insertMessageStmt.run({
    userId,
    sessionId,
    role,
    text,
    createdAt,
  });
  updateSessionMessageMetadataStmt.run({
    userId,
    sessionId,
    createdAt,
    lastMessagePreview: String(text).slice(0, 160),
  });
});

const addConversationTx = db.transaction(({
  userId,
  sessionId,
  userText,
  assistantText,
  userCreatedAt,
  assistantCreatedAt,
}) => {
  insertMessageStmt.run({
    userId,
    sessionId,
    role: 'user',
    text: userText,
    createdAt: userCreatedAt,
  });

  insertMessageStmt.run({
    userId,
    sessionId,
    role: 'assistant',
    text: assistantText,
    createdAt: assistantCreatedAt,
  });

  updateSessionMessageMetadataStmt.run({
    userId,
    sessionId,
    createdAt: assistantCreatedAt,
    lastMessagePreview: String(assistantText).slice(0, 160),
  });
});

function normalizeMessageText(text) {
  const normalizedText = String(text || '').trim();
  if (!normalizedText) {
    const error = new Error('Chat message text is required.');
    error.statusCode = 400;
    throw error;
  }
  return normalizedText;
}

function normalizeUserId(userId) {
  const normalizedUserId = Number(userId);
  if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) {
    const error = new Error('userId must be a positive integer.');
    error.statusCode = 400;
    throw error;
  }
  return normalizedUserId;
}

function addMessage({ userId, sessionId, role, text, createdAt }) {
  const normalizedUserId = normalizeUserId(userId);
  if (!ALLOWED_ROLES.has(role)) {
    const error = new Error('Invalid chat role.');
    error.statusCode = 400;
    throw error;
  }
  const normalizedText = normalizeMessageText(text);

  const timestamp = createdAt || new Date().toISOString();
  addMessageTx({
    userId: normalizedUserId,
    sessionId,
    role,
    text: normalizedText,
    createdAt: timestamp,
  });
}

function addConversation({ userId, sessionId, userText, assistantText, createdAt }) {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedUserText = normalizeMessageText(userText);
  const normalizedAssistantText = normalizeMessageText(assistantText);
  const userCreatedAt = createdAt || new Date().toISOString();
  const assistantCreatedAt = new Date(new Date(userCreatedAt).getTime() + 1).toISOString();

  addConversationTx({
    userId: normalizedUserId,
    sessionId,
    userText: normalizedUserText,
    assistantText: normalizedAssistantText,
    userCreatedAt,
    assistantCreatedAt,
  });
}

function listSessionHistory(sessionId, userId, options = {}) {
  const normalizedUserId = normalizeUserId(userId);
  const requestedLimit = Number(options.limit ?? 1000);
  const requestedOffset = Number(options.offset ?? 0);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 5000)
    : 1000;
  const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0
    ? requestedOffset
    : 0;

  return listMessagesStmt
    .all({ sessionId, userId: normalizedUserId, limit, offset })
    .map((row) => ({
      id: String(row.id),
      role: row.role,
      text: row.text,
      createdAt: row.createdAt,
    }));
}

function clearSessionHistory(sessionId, userId) {
  const normalizedUserId = normalizeUserId(userId);
  const clearTx = db.transaction((id, ownerId) => {
    deleteMessagesStmt.run(id, ownerId);
    clearSessionMessageMetadataStmt.run(id, ownerId);
  });
  clearTx(sessionId, normalizedUserId);
  return { cleared: true };
}

module.exports = {
  addMessage,
  addConversation,
  listSessionHistory,
  clearSessionHistory,
};
