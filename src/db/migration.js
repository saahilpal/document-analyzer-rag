const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

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
      description: 'Create users table',
      sql: `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,
    },
    {
      description: 'Create sessions table',
      sql: `CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT,
        last_message_at TEXT,
        last_message_preview TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );`,
    },
    {
      description: 'Create pdfs table',
      sql: `CREATE TABLE IF NOT EXISTS pdfs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        sessionId INTEGER NOT NULL,
        title TEXT NOT NULL,
        filename TEXT NOT NULL,
        path TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        indexedChunks INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
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
        user_id INTEGER NOT NULL,
        sessionId INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
      );`,
    },
    {
      description: 'Create auth_sessions table',
      sql: `CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        device_info TEXT,
        ip_address TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
      description: 'Create users email index',
      sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);',
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
    {
      description: 'Create job_queue payload user+session index',
      sql: "CREATE INDEX IF NOT EXISTS idx_job_queue_payload_user_session ON job_queue(CAST(json_extract(payload, '$.userId') AS INTEGER), CAST(json_extract(payload, '$.sessionId') AS INTEGER));",
    },
    {
      description: 'Create job_queue payload user+pdf index',
      sql: "CREATE INDEX IF NOT EXISTS idx_job_queue_payload_user_pdf ON job_queue(CAST(json_extract(payload, '$.userId') AS INTEGER), CAST(json_extract(payload, '$.pdfId') AS INTEGER));",
    },
    {
      description: 'Create auth_sessions user_id index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);',
    },
    {
      description: 'Create auth_sessions token_hash index',
      sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_sessions_token_hash ON auth_sessions(token_hash);',
    },
    {
      description: 'Create auth_sessions expires_at index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);',
    },
  ];

  for (const statement of statements) {
    logAction(actions, statement.sql, statement.description);
    db.exec(statement.sql);
  }
}

function ensureOwnershipColumns(db, actions) {
  if (!columnExists(db, 'sessions', 'user_id')) {
    const sql = 'ALTER TABLE sessions ADD COLUMN user_id INTEGER;';
    logAction(actions, sql, 'Add sessions.user_id column');
    db.exec(sql);
  }
  if (columnExists(db, 'sessions', 'user_id')) {
    const sql = 'CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);';
    logAction(actions, sql, 'Create sessions user_id index');
    db.exec(sql);

    const sortSql = 'CREATE INDEX IF NOT EXISTS idx_sessions_user_id_last_message_at ON sessions(user_id, last_message_at, id);';
    logAction(actions, sortSql, 'Create sessions user_id + last_message_at index');
    db.exec(sortSql);

    const searchSql = 'CREATE INDEX IF NOT EXISTS idx_sessions_user_id_title ON sessions(user_id, title);';
    logAction(actions, searchSql, 'Create sessions user_id + title index');
    db.exec(searchSql);
  }

  if (!columnExists(db, 'pdfs', 'user_id')) {
    const sql = 'ALTER TABLE pdfs ADD COLUMN user_id INTEGER;';
    logAction(actions, sql, 'Add pdfs.user_id column');
    db.exec(sql);
  }
  if (columnExists(db, 'pdfs', 'user_id')) {
    const sql = 'CREATE INDEX IF NOT EXISTS idx_pdfs_user_id ON pdfs(user_id);';
    logAction(actions, sql, 'Create pdfs user_id index');
    db.exec(sql);

    const scopedSql = 'CREATE INDEX IF NOT EXISTS idx_pdfs_user_id_sessionId ON pdfs(user_id, sessionId);';
    logAction(actions, scopedSql, 'Create pdfs user_id + sessionId index');
    db.exec(scopedSql);
  }

  if (!columnExists(db, 'chat_messages', 'user_id')) {
    const sql = 'ALTER TABLE chat_messages ADD COLUMN user_id INTEGER;';
    logAction(actions, sql, 'Add chat_messages.user_id column');
    db.exec(sql);
  }
  if (columnExists(db, 'chat_messages', 'user_id')) {
    const sql = 'CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id ON chat_messages(user_id);';
    logAction(actions, sql, 'Create chat_messages user_id index');
    db.exec(sql);

    const scopedSql = 'CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id_sessionId ON chat_messages(user_id, sessionId);';
    logAction(actions, scopedSql, 'Create chat_messages user_id + sessionId index');
    db.exec(scopedSql);
  }
}

function getDefaultAdminIdentity() {
  const email = String(process.env.DEFAULT_ADMIN_EMAIL || 'admin@local').trim().toLowerCase();
  const name = String(process.env.DEFAULT_ADMIN_NAME || 'Default Admin').trim() || 'Default Admin';
  let password = String(process.env.DEFAULT_ADMIN_PASSWORD || '').trim();
  let generated = false;

  if (password.length < 8) {
    password = crypto.randomBytes(24).toString('base64url');
    generated = true;
  }

  return {
    email,
    name,
    password,
    generated,
  };
}

function ensureDefaultAdminUser(db, actions, options = {}) {
  const dryRun = options.dryRun === true;
  if (!tableExists(db, 'users')) {
    return null;
  }

  const identity = getDefaultAdminIdentity();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(identity.email);
  if (existing?.id) {
    return Number(existing.id);
  }

  const now = new Date().toISOString();
  const passwordHash = bcrypt.hashSync(identity.password, 12);
  const result = db.prepare(`
    INSERT INTO users (name, email, password_hash, created_at, updated_at)
    VALUES (@name, @email, @password_hash, @created_at, @updated_at)
  `).run({
    name: identity.name,
    email: identity.email,
    password_hash: passwordHash,
    created_at: now,
    updated_at: now,
  });
  const adminId = Number(result.lastInsertRowid);
  logAction(actions, 'INSERT INTO users (...) VALUES (...)', `Create default admin user (${identity.email})`);

  if (identity.generated && !dryRun) {
    // eslint-disable-next-line no-console
    console.warn(`[migrate] DEFAULT_ADMIN_PASSWORD was not set. Generated admin password for ${identity.email}: ${identity.password}`);
  }

  return adminId;
}

function backfillOwnershipColumns(db, actions, defaultAdminId) {
  if (!Number.isInteger(defaultAdminId) || defaultAdminId <= 0) {
    return;
  }

  if (tableExists(db, 'sessions') && columnExists(db, 'sessions', 'user_id')) {
    const sql = 'UPDATE sessions SET user_id = ? WHERE user_id IS NULL;';
    logAction(actions, sql, 'Backfill sessions.user_id');
    db.prepare(sql).run(defaultAdminId);
  }

  if (tableExists(db, 'pdfs') && columnExists(db, 'pdfs', 'user_id')) {
    const sql = 'UPDATE pdfs SET user_id = ? WHERE user_id IS NULL;';
    logAction(actions, sql, 'Backfill pdfs.user_id');
    db.prepare(sql).run(defaultAdminId);
  }

  if (tableExists(db, 'chat_messages') && columnExists(db, 'chat_messages', 'user_id')) {
    const sql = 'UPDATE chat_messages SET user_id = ? WHERE user_id IS NULL;';
    logAction(actions, sql, 'Backfill chat_messages.user_id');
    db.prepare(sql).run(defaultAdminId);
  }
}

function ensureSessionUpdatedAtColumn(db, actions) {
  if (!columnExists(db, 'sessions', 'updatedAt')) {
    const sql = 'ALTER TABLE sessions ADD COLUMN updatedAt TEXT;';
    logAction(actions, sql, 'Add sessions.updatedAt column');
    db.exec(sql);
  }

  if (!columnExists(db, 'sessions', 'updatedAt')) {
    return;
  }

  const normalizeSql = `
    UPDATE sessions
    SET updatedAt = COALESCE(NULLIF(updatedAt, ''), createdAt)
    WHERE updatedAt IS NULL OR updatedAt = '';
  `;
  logAction(actions, normalizeSql.trim(), 'Backfill sessions.updatedAt');
  db.exec(normalizeSql);
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
    ensureOwnershipColumns(db, actions);
    const defaultAdminId = ensureDefaultAdminUser(db, actions, { dryRun });
    backfillOwnershipColumns(db, actions, defaultAdminId);
    ensureSessionUpdatedAtColumn(db, actions);
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
