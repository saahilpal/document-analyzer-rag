const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(process.cwd(), 'data');
const dbPath = path.join(dataDir, 'studyrag.sqlite');

function ensureDataDir() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
  }
}

function openDatabase() {
  ensureDataDir();
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  return db;
}

function tableExists(db, tableName) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return !!row;
}

function logAction(actions, sql, description) {
  actions.push({ sql, description });
}

function columnExists(db, tableName, columnName) {
  if (!tableExists(db, tableName)) {
    return false;
  }
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name);
  return columns.includes(columnName);
}

function ensureNewTables(db, actions) {
  const statements = [
    {
      description: 'Create sessions table',
      sql: `CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        last_message_at TEXT,
        last_message_preview TEXT
      );`,
    },
    {
      description: 'Create pdfs table',
      sql: `CREATE TABLE IF NOT EXISTS pdfs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId INTEGER NOT NULL,
        title TEXT NOT NULL,
        filename TEXT NOT NULL,
        path TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        indexedChunks INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
      );`,
    },
    {
      description: 'Create chunks table',
      sql: `CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        sessionId INTEGER NOT NULL,
        pdfId INTEGER,
        chunkKey TEXT,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        embeddingVectorLength INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (pdfId) REFERENCES pdfs(id) ON DELETE CASCADE
      );`,
    },
    {
      description: 'Create chat_messages table',
      sql: `CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
      );`,
    },
    {
      description: 'Create job_queue table',
      sql: `CREATE TABLE IF NOT EXISTS job_queue (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        stage TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        maxRetries INTEGER NOT NULL DEFAULT 3,
        result TEXT,
        error TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );`,
    },
    {
      description: 'Create pdfs sessionId index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_pdfs_sessionId ON pdfs(sessionId);',
    },
    {
      description: 'Create pdfs status index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_pdfs_status ON pdfs(status);',
    },
    {
      description: 'Create chunks sessionId index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_chunks_sessionId ON chunks(sessionId);',
    },
    {
      description: 'Create chunks pdfId index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_chunks_pdfId ON chunks(pdfId);',
    },
    {
      description: 'Create chunks createdAt index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_chunks_createdAt ON chunks(createdAt);',
    },
    {
      description: 'Create chat_messages sessionId index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_chat_messages_sessionId ON chat_messages(sessionId);',
    },
    {
      description: 'Create chat_messages sessionId+createdAt+id index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_chat_messages_sessionId_createdAt_id ON chat_messages(sessionId, createdAt, id);',
    },
    {
      description: 'Create job_queue status index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status);',
    },
    {
      description: 'Create job_queue updatedAt index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_job_queue_updatedAt ON job_queue(updatedAt);',
    },
  ];

  for (const statement of statements) {
    logAction(actions, statement.sql, statement.description);
    db.exec(statement.sql);
  }
}

function ensureSessionMetadataColumns(db, actions) {
  if (!columnExists(db, 'sessions', 'last_message_at')) {
    const sql = 'ALTER TABLE sessions ADD COLUMN last_message_at TEXT;';
    logAction(actions, sql, 'Add sessions.last_message_at column');
    db.exec(sql);
  }

  if (!columnExists(db, 'sessions', 'last_message_preview')) {
    const sql = 'ALTER TABLE sessions ADD COLUMN last_message_preview TEXT;';
    logAction(actions, sql, 'Add sessions.last_message_preview column');
    db.exec(sql);
  }

  const indexSql = 'CREATE INDEX IF NOT EXISTS idx_sessions_last_message_at ON sessions(last_message_at);';
  logAction(actions, indexSql, 'Create sessions last_message_at index');
  db.exec(indexSql);
}

function ensureChunkIdempotencyColumns(db, actions) {
  if (!columnExists(db, 'chunks', 'chunkKey')) {
    const sql = 'ALTER TABLE chunks ADD COLUMN chunkKey TEXT;';
    logAction(actions, sql, 'Add chunks.chunkKey column');
    db.exec(sql);
  }

  if (tableExists(db, 'chunks')) {
    const backfillSql = `
      UPDATE chunks
      SET chunkKey = COALESCE(NULLIF(chunkKey, ''), id)
      WHERE chunkKey IS NULL OR chunkKey = '';
    `;
    logAction(actions, backfillSql.trim(), 'Backfill chunks.chunkKey values');
    db.exec(backfillSql);
  }

  const indexSql = 'CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_pdf_chunkKey_unique ON chunks(pdfId, chunkKey);';
  logAction(actions, indexSql, 'Create chunks pdfId+chunkKey unique index');
  db.exec(indexSql);
}

function ensureJobProgressColumns(db, actions) {
  if (!columnExists(db, 'job_queue', 'progress')) {
    const sql = 'ALTER TABLE job_queue ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;';
    logAction(actions, sql, 'Add job_queue.progress column');
    db.exec(sql);
  }

  if (!columnExists(db, 'job_queue', 'stage')) {
    const sql = 'ALTER TABLE job_queue ADD COLUMN stage TEXT;';
    logAction(actions, sql, 'Add job_queue.stage column');
    db.exec(sql);
  }

  if (tableExists(db, 'job_queue')) {
    const normalizeSql = `
      UPDATE job_queue
      SET progress = CASE
        WHEN status = 'completed' THEN 100
        ELSE COALESCE(progress, 0)
      END
      WHERE progress IS NULL OR progress < 0 OR progress > 100;
    `;
    logAction(actions, normalizeSql.trim(), 'Normalize job_queue.progress values');
    db.exec(normalizeSql);
  }
}

function normalizeChatMessageTimestamps(db, actions) {
  if (!tableExists(db, 'chat_messages')) {
    return;
  }

  const sql = `
    UPDATE chat_messages
    SET createdAt = COALESCE(NULLIF(createdAt, ''), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE createdAt IS NULL OR createdAt = '';
  `;
  logAction(actions, sql.trim(), 'Normalize missing chat_messages.createdAt');
  db.exec(sql);
}

function backfillSessionMessageMetadata(db, actions) {
  if (!tableExists(db, 'sessions') || !tableExists(db, 'chat_messages')) {
    return;
  }

  const clearSql = `
    UPDATE sessions
    SET last_message_at = NULL,
        last_message_preview = NULL;
  `;
  logAction(actions, clearSql.trim(), 'Reset sessions message metadata before backfill');
  db.exec(clearSql);

  const sql = `
    UPDATE sessions
    SET
      last_message_at = (
        SELECT m.createdAt
        FROM chat_messages m
        WHERE m.sessionId = sessions.id
        ORDER BY m.createdAt DESC, m.id DESC
        LIMIT 1
      ),
      last_message_preview = (
        SELECT substr(m.text, 1, 160)
        FROM chat_messages m
        WHERE m.sessionId = sessions.id
        ORDER BY m.createdAt DESC, m.id DESC
        LIMIT 1
      );
  `;
  logAction(actions, sql.trim(), 'Backfill sessions last_message_at/preview from chat_messages');
  db.exec(sql);
}

function runMigrations({ dryRun = false } = {}) {
  const db = openDatabase();
  const actions = [];

  const execute = () => {
    ensureNewTables(db, actions);
    ensureSessionMetadataColumns(db, actions);
    ensureChunkIdempotencyColumns(db, actions);
    ensureJobProgressColumns(db, actions);
    normalizeChatMessageTimestamps(db, actions);
    backfillSessionMessageMetadata(db, actions);
  };

  if (dryRun) {
    db.exec('BEGIN;');
    try {
      execute();
      db.exec('ROLLBACK;');
    } catch (error) {
      db.exec('ROLLBACK;');
      db.close();
      throw error;
    }
  } else {
    execute();
  }

  db.close();
  return actions;
}

module.exports = {
  dbPath,
  openDatabase,
  runMigrations,
};
