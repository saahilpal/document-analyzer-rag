const db = require('../db/database');
const { invalidatePdfCache } = require('./vectorService');

const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name);
const hasUpdatedAtColumn = sessionColumns.includes('updatedAt');
const UPDATED_AT_SELECT_SQL = hasUpdatedAtColumn ? 's.updatedAt' : 's.createdAt AS updatedAt';
const UPDATED_AT_SELECT_WITHOUT_ALIAS_SQL = hasUpdatedAtColumn ? 'updatedAt' : 'createdAt AS updatedAt';

const listSessionsStmt = db.prepare(`
  SELECT
    s.id,
    s.title,
    s.createdAt,
    ${UPDATED_AT_SELECT_SQL},
    s.last_message_at AS lastMessageAt,
    COALESCE(s.last_message_preview, '') AS lastMessagePreview,
    COALESCE((
      SELECT COUNT(*)
      FROM chat_messages cm
      WHERE cm.sessionId = s.id AND cm.user_id = s.user_id
    ), 0) AS messageCount,
    COALESCE((
      SELECT COUNT(*)
      FROM pdfs p
      WHERE p.sessionId = s.id AND p.user_id = s.user_id
    ), 0) AS pdfCount
  FROM sessions s
  WHERE s.user_id = @userId
  ORDER BY (s.last_message_at IS NULL) ASC, s.last_message_at DESC, s.id DESC
  LIMIT @limit
`);

const searchSessionsStmt = db.prepare(`
  SELECT
    s.id,
    s.title,
    s.createdAt,
    ${UPDATED_AT_SELECT_SQL},
    s.last_message_at AS lastMessageAt,
    COALESCE(s.last_message_preview, '') AS lastMessagePreview,
    COALESCE((
      SELECT COUNT(*)
      FROM chat_messages cm
      WHERE cm.sessionId = s.id AND cm.user_id = s.user_id
    ), 0) AS messageCount,
    COALESCE((
      SELECT COUNT(*)
      FROM pdfs p
      WHERE p.sessionId = s.id AND p.user_id = s.user_id
    ), 0) AS pdfCount
  FROM sessions s
  WHERE s.user_id = @userId
    AND s.title LIKE @pattern ESCAPE '\\' COLLATE NOCASE
  ORDER BY (s.last_message_at IS NULL) ASC, s.last_message_at DESC, s.id DESC
  LIMIT @limit
`);

const insertSessionStmt = hasUpdatedAtColumn
  ? db.prepare(`
      INSERT INTO sessions (user_id, title, createdAt, updatedAt)
      VALUES (@userId, @title, @createdAt, @updatedAt)
    `)
  : db.prepare(`
      INSERT INTO sessions (user_id, title, createdAt)
      VALUES (@userId, @title, @createdAt)
    `);

const getSessionStmt = db.prepare(`
  SELECT
    id,
    title,
    createdAt,
    ${UPDATED_AT_SELECT_WITHOUT_ALIAS_SQL},
    last_message_at AS lastMessageAt,
    COALESCE(last_message_preview, '') AS lastMessagePreview
  FROM sessions
  WHERE id = ? AND user_id = ?
`);

const getSessionMetaStmt = db.prepare(`
  SELECT
    s.id,
    s.title,
    s.createdAt,
    ${UPDATED_AT_SELECT_SQL},
    COALESCE((
      SELECT COUNT(*)
      FROM pdfs p
      WHERE p.sessionId = s.id AND p.user_id = s.user_id
    ), 0) AS pdfCount,
    COALESCE((
      SELECT COUNT(*)
      FROM chat_messages cm
      WHERE cm.sessionId = s.id AND cm.user_id = s.user_id
    ), 0) AS messageCount
  FROM sessions s
  WHERE s.id = @sessionId AND s.user_id = @userId
  LIMIT 1
`);

const deleteSessionStmt = db.prepare(`
  DELETE FROM sessions
  WHERE id = ? AND user_id = ?
`);

const deleteSessionPdfsStmt = db.prepare(`
  DELETE FROM pdfs
  WHERE sessionId = ? AND user_id = ?
`);

const deleteSessionChunksStmt = db.prepare(`
  DELETE FROM chunks
  WHERE sessionId = ? AND sessionId IN (SELECT id FROM sessions WHERE id = ? AND user_id = ?)
`);

const deleteSessionHistoryStmt = db.prepare(`
  DELETE FROM chat_messages
  WHERE sessionId = ? AND user_id = ?
`);

const listSessionPdfFilesStmt = db.prepare(`
  SELECT id, path
  FROM pdfs
  WHERE sessionId = ? AND user_id = ?
`);

const selectSessionJobIdsStmt = db.prepare(`
  SELECT j.id
  FROM job_queue j
  WHERE CAST(json_extract(j.payload, '$.userId') AS INTEGER) = @userId
    AND (
      CAST(json_extract(j.payload, '$.sessionId') AS INTEGER) = @sessionId
      OR CAST(json_extract(j.payload, '$.pdfId') AS INTEGER) IN (
        SELECT p.id
        FROM pdfs p
        WHERE p.sessionId = @sessionId AND p.user_id = @userId
      )
    )
`);

const deleteSessionJobByIdStmt = db.prepare(`
  DELETE FROM job_queue
  WHERE id = ?
`);

const updateSessionTitleStmt = hasUpdatedAtColumn
  ? db.prepare(`
      UPDATE sessions
      SET title = @title,
          updatedAt = @updatedAt
      WHERE id = @id AND user_id = @userId
    `)
  : db.prepare(`
      UPDATE sessions
      SET title = @title
      WHERE id = @id AND user_id = @userId
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

function normalizeSessionTitle(title, maxLength = 160) {
  const normalizedTitle = String(title || '').trim();
  if (!normalizedTitle) {
    const error = new Error('title is required and must be a non-empty string.');
    error.statusCode = 400;
    error.code = 'INVALID_SESSION_TITLE';
    throw error;
  }
  if (normalizedTitle.length > maxLength) {
    const error = new Error(`title must be at most ${maxLength} characters.`);
    error.statusCode = 422;
    error.code = 'VALIDATION_ERROR';
    throw error;
  }
  return normalizedTitle;
}

function escapeLikePattern(value) {
  return String(value || '').replace(/[\\%_]/g, '\\$&');
}

function formatSessionListItem(session) {
  const normalizedLastMessageAt = session.lastMessageAt || null;
  const normalizedLastMessage = String(session.lastMessagePreview || '');

  return {
    id: Number(session.id),
    title: String(session.title || '').trim() || `Session ${session.id}`,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt || session.createdAt,
    last_message: normalizedLastMessage,
    last_message_at: normalizedLastMessageAt,
    lastMessagePreview: normalizedLastMessage,
    lastMessageAt: normalizedLastMessageAt,
    messageCount: Number(session.messageCount || 0),
    pdfCount: Number(session.pdfCount || 0),
  };
}

function listSessions(userId, options = {}) {
  const normalizedUserId = normalizeUserId(userId);
  const requestedLimit = Number(options.limit ?? 100);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 100)
    : 100;

  return listSessionsStmt.all({ userId: normalizedUserId, limit }).map(formatSessionListItem);
}

function searchSessionsByTitle(userId, query, options = {}) {
  const normalizedUserId = normalizeUserId(userId);
  const term = String(query || '').trim();
  if (!term) {
    return [];
  }

  const requestedLimit = Number(options.limit ?? 50);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 50)
    : 50;

  const pattern = `%${escapeLikePattern(term)}%`;
  return searchSessionsStmt.all({
    userId: normalizedUserId,
    pattern,
    limit,
  }).map(formatSessionListItem);
}

function getSessionById(sessionId, userId) {
  const row = getSessionStmt.get(sessionId, normalizeUserId(userId)) || null;
  if (!row) {
    return null;
  }
  return {
    ...row,
    title: String(row.title || '').trim() || `Session ${row.id}`,
    lastMessageAt: row.lastMessageAt || null,
    lastMessagePreview: String(row.lastMessagePreview || ''),
    updatedAt: row.updatedAt || row.createdAt,
  };
}

function createSession(userId, title) {
  const normalizedUserId = normalizeUserId(userId);

  const normalizedTitle = normalizeSessionTitle(title, 160);

  const now = new Date().toISOString();
  const payload = {
    userId: normalizedUserId,
    title: normalizedTitle,
    createdAt: now,
  };
  if (hasUpdatedAtColumn) {
    payload.updatedAt = now;
  }
  const result = insertSessionStmt.run(payload);

  return getSessionById(Number(result.lastInsertRowid), normalizedUserId);
}

function renameSession(sessionId, userId, title) {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedTitle = normalizeSessionTitle(title, 60);
  const session = assertSessionExists(sessionId, normalizedUserId);

  const now = new Date().toISOString();
  const payload = {
    id: session.id,
    userId: normalizedUserId,
    title: normalizedTitle,
  };
  if (hasUpdatedAtColumn) {
    payload.updatedAt = now;
  }

  updateSessionTitleStmt.run(payload);
  return getSessionById(session.id, normalizedUserId);
}

function assertSessionExists(sessionId, userId) {
  const session = getSessionById(sessionId, userId);
  if (!session) {
    const error = new Error('sessionId does not exist.');
    error.statusCode = 400;
    throw error;
  }
  return session;
}

function getSessionMetadata(sessionId, userId) {
  const normalizedUserId = normalizeUserId(userId);
  const row = getSessionMetaStmt.get({
    sessionId,
    userId: normalizedUserId,
  });

  if (!row) {
    const error = new Error('sessionId does not exist.');
    error.statusCode = 400;
    error.code = 'INVALID_SESSION_ID';
    throw error;
  }

  return {
    id: Number(row.id),
    title: String(row.title || '').trim() || `Session ${row.id}`,
    created_at: row.createdAt,
    updated_at: row.updatedAt || row.createdAt,
    pdfCount: Number(row.pdfCount || 0),
    messageCount: Number(row.messageCount || 0),
  };
}

function deleteSession(sessionId, userId) {
  const normalizedUserId = normalizeUserId(userId);
  const session = assertSessionExists(sessionId, normalizedUserId);

  const remove = db.transaction((id, ownerId) => {
    const pdfRows = listSessionPdfFilesStmt.all(id, ownerId);
    const deletedJobIds = selectSessionJobIdsStmt
      .all({ sessionId: id, userId: ownerId })
      .map((row) => String(row.id))
      .filter(Boolean);

    for (const jobId of deletedJobIds) {
      deleteSessionJobByIdStmt.run(jobId);
    }

    for (const pdf of pdfRows) {
      invalidatePdfCache(pdf.id);
    }

    deleteSessionHistoryStmt.run(id, ownerId);
    deleteSessionChunksStmt.run(id, id, ownerId);
    deleteSessionPdfsStmt.run(id, ownerId);
    deleteSessionStmt.run(id, ownerId);

    return {
      pdfPaths: pdfRows
        .map((pdf) => String(pdf.path || '').trim())
        .filter(Boolean),
      deletedJobIds,
    };
  });

  const result = remove(session.id, normalizedUserId);
  return {
    deleted: true,
    id: session.id,
    deletedJobIds: result.deletedJobIds,
    deletedPdfPaths: result.pdfPaths,
  };
}

module.exports = {
  listSessions,
  searchSessionsByTitle,
  createSession,
  renameSession,
  getSessionById,
  getSessionMetadata,
  assertSessionExists,
  deleteSession,
};
