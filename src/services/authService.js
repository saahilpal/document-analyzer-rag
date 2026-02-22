const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { createHttpError } = require('../utils/errors');

const AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_SESSION_CLEANUP_INTERVAL_MS = 60 * 1000;
const BCRYPT_ROUNDS = 12;

const LOGIN_WINDOW_MS = Number(process.env.AUTH_LOGIN_WINDOW_MS) || 15 * 60 * 1000;
const LOGIN_LOCK_MS = Number(process.env.AUTH_LOGIN_LOCK_MS) || 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = Number(process.env.AUTH_LOGIN_MAX_FAILURES) || 6;
const LOGIN_MAX_TRACKED_KEYS = 20_000;

const DUMMY_PASSWORD_HASH = bcrypt.hashSync('invalid-password-placeholder', BCRYPT_ROUNDS);
const loginFailures = new Map();

let lastSessionCleanupAt = 0;

const insertUserStmt = db.prepare(`
  INSERT INTO users (name, email, password_hash, created_at, updated_at)
  VALUES (@name, @email, @passwordHash, @createdAt, @updatedAt)
`);

const getUserByIdStmt = db.prepare(`
  SELECT
    id,
    name,
    email,
    password_hash AS passwordHash,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM users
  WHERE id = ?
`);

const getUserByEmailStmt = db.prepare(`
  SELECT
    id,
    name,
    email,
    password_hash AS passwordHash,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM users
  WHERE email = ?
`);

const insertAuthSessionStmt = db.prepare(`
  INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at, device_info, ip_address)
  VALUES (@id, @userId, @tokenHash, @expiresAt, @createdAt, @deviceInfo, @ipAddress)
`);

const getAuthSessionByTokenHashStmt = db.prepare(`
  SELECT
    s.id AS sessionId,
    s.user_id AS sessionUserId,
    s.expires_at AS expiresAt,
    u.id,
    u.name,
    u.email,
    u.password_hash AS passwordHash,
    u.created_at AS createdAt,
    u.updated_at AS updatedAt
  FROM auth_sessions s
  INNER JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ?
    AND s.expires_at > ?
  LIMIT 1
`);

const deleteAuthSessionByIdStmt = db.prepare(`
  DELETE FROM auth_sessions
  WHERE id = ?
`);

const deleteAuthSessionByTokenHashStmt = db.prepare(`
  DELETE FROM auth_sessions
  WHERE token_hash = ?
`);

const deleteExpiredAuthSessionsStmt = db.prepare(`
  DELETE FROM auth_sessions
  WHERE expires_at <= ?
`);

function sanitizeString(value, maxLength = 300) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeName(name) {
  return String(name || '').trim();
}

function toPublicUser(user) {
  return {
    id: Number(user.id),
    name: String(user.name || ''),
    email: String(user.email || ''),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function toBase64Url(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function generateSessionToken() {
  return toBase64Url(crypto.randomBytes(48));
}

function hashSessionToken(token) {
  return crypto
    .createHash('sha256')
    .update(String(token || ''))
    .digest('hex');
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    bcrypt.hash(String(password || ''), BCRYPT_ROUNDS, (error, hashed) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(hashed);
    });
  });
}

function hashPasswordWithStoredSalt(password, storedHash) {
  return new Promise((resolve, reject) => {
    bcrypt.hash(String(password || ''), String(storedHash || ''), (error, hashed) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(hashed);
    });
  });
}

async function comparePasswordConstantTime(password, storedHash) {
  const safeStoredHash = String(storedHash || '');
  const hashSource = safeStoredHash || DUMMY_PASSWORD_HASH;

  let candidateHash;
  try {
    candidateHash = await hashPasswordWithStoredSalt(password, hashSource);
  } catch {
    candidateHash = await hashPasswordWithStoredSalt(password, DUMMY_PASSWORD_HASH);
  }

  const left = Buffer.from(hashSource);
  const right = Buffer.from(candidateHash);
  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function pruneLoginFailures(now) {
  for (const [key, entry] of loginFailures.entries()) {
    const idleForMs = now - entry.lastAttemptAt;
    const unlocked = entry.lockedUntil <= now;
    if (idleForMs > LOGIN_WINDOW_MS && unlocked) {
      loginFailures.delete(key);
    }
  }

  while (loginFailures.size > LOGIN_MAX_TRACKED_KEYS) {
    const oldestKey = loginFailures.keys().next().value;
    loginFailures.delete(oldestKey);
  }
}

function getLoginFailureKey(email, ipAddress) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedIp = sanitizeString(ipAddress, 120) || 'unknown';
  return `${normalizedEmail}|${normalizedIp}`;
}

function getFailureEntry(key, now) {
  const current = loginFailures.get(key);
  if (!current) {
    return {
      failures: 0,
      windowStart: now,
      lockedUntil: 0,
      lastAttemptAt: now,
    };
  }

  if (now - current.windowStart > LOGIN_WINDOW_MS) {
    return {
      failures: 0,
      windowStart: now,
      lockedUntil: current.lockedUntil > now ? current.lockedUntil : 0,
      lastAttemptAt: current.lastAttemptAt,
    };
  }

  return current;
}

function assertLoginAllowed(email, ipAddress) {
  const now = Date.now();
  pruneLoginFailures(now);
  const key = getLoginFailureKey(email, ipAddress);
  const entry = getFailureEntry(key, now);

  if (entry.lockedUntil > now) {
    const error = createHttpError(429, 'INVALID_CREDENTIALS', 'Invalid email or password.', {
      retryable: true,
    });
    error.retryAfterSeconds = Math.ceil((entry.lockedUntil - now) / 1000);
    throw error;
  }
}

function markFailedLogin(email, ipAddress) {
  const now = Date.now();
  pruneLoginFailures(now);

  const key = getLoginFailureKey(email, ipAddress);
  const entry = getFailureEntry(key, now);
  entry.failures += 1;
  entry.lastAttemptAt = now;

  if (entry.failures >= LOGIN_MAX_FAILURES) {
    entry.failures = 0;
    entry.windowStart = now;
    entry.lockedUntil = now + LOGIN_LOCK_MS;
  }

  loginFailures.set(key, entry);
}

function clearFailedLogin(email, ipAddress) {
  const key = getLoginFailureKey(email, ipAddress);
  loginFailures.delete(key);
}

function maybeCleanupExpiredAuthSessions() {
  const nowMs = Date.now();
  if (nowMs - lastSessionCleanupAt < AUTH_SESSION_CLEANUP_INTERVAL_MS) {
    return;
  }
  lastSessionCleanupAt = nowMs;
  deleteExpiredAuthSessionsStmt.run(new Date(nowMs).toISOString());
}

function cleanupExpiredAuthSessions() {
  const result = deleteExpiredAuthSessionsStmt.run(new Date().toISOString());
  lastSessionCleanupAt = Date.now();
  return Number(result.changes) || 0;
}

function getUserByEmail(email) {
  return getUserByEmailStmt.get(normalizeEmail(email)) || null;
}

function getUserById(userId) {
  return getUserByIdStmt.get(userId) || null;
}

async function createUser({ name, email, password }) {
  const normalizedName = normalizeName(name);
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = String(password || '');

  if (!normalizedName || !normalizedEmail || normalizedPassword.length < 8) {
    throw createHttpError(400, 'INVALID_AUTH_INPUT', 'Unable to register with provided credentials.', {
      retryable: false,
    });
  }

  const passwordHash = await hashPassword(normalizedPassword);
  const now = new Date().toISOString();

  try {
    const result = insertUserStmt.run({
      name: normalizedName,
      email: normalizedEmail,
      passwordHash,
      createdAt: now,
      updatedAt: now,
    });

    const user = getUserById(Number(result.lastInsertRowid));
    if (!user) {
      throw createHttpError(500, 'INTERNAL_ERROR', 'Unable to register with provided credentials.');
    }
    return user;
  } catch (error) {
    if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
      throw createHttpError(400, 'INVALID_AUTH_INPUT', 'Unable to register with provided credentials.', {
        retryable: false,
      });
    }
    throw error;
  }
}

async function authenticateUser({ email, password, ipAddress }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = String(password || '');

  assertLoginAllowed(normalizedEmail, ipAddress);

  const user = getUserByEmail(normalizedEmail);
  const hashToCompare = user?.passwordHash || DUMMY_PASSWORD_HASH;

  const matches = await comparePasswordConstantTime(normalizedPassword, hashToCompare);

  if (!user || !matches) {
    markFailedLogin(normalizedEmail, ipAddress);
    throw createHttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.', {
      retryable: false,
    });
  }

  clearFailedLogin(normalizedEmail, ipAddress);
  return user;
}

function createAuthSession({ userId, deviceInfo, ipAddress }) {
  const normalizedUserId = Number(userId);
  if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) {
    throw createHttpError(400, 'INVALID_USER_ID', 'Invalid auth session user.', {
      retryable: false,
    });
  }

  maybeCleanupExpiredAuthSessions();

  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + AUTH_SESSION_TTL_MS).toISOString();

  insertAuthSessionStmt.run({
    id: crypto.randomUUID(),
    userId: normalizedUserId,
    tokenHash,
    expiresAt,
    createdAt,
    deviceInfo: sanitizeString(deviceInfo),
    ipAddress: sanitizeString(ipAddress, 120),
  });

  return {
    token,
    expiresAt,
  };
}

function getAuthContextByToken(token) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) {
    return null;
  }

  maybeCleanupExpiredAuthSessions();

  const tokenHash = hashSessionToken(normalizedToken);
  const row = getAuthSessionByTokenHashStmt.get(tokenHash, new Date().toISOString());
  if (!row) {
    return null;
  }

  return {
    sessionId: row.sessionId,
    expiresAt: row.expiresAt,
    user: toPublicUser(row),
  };
}

function deleteAuthSessionById(sessionId) {
  const result = deleteAuthSessionByIdStmt.run(String(sessionId || ''));
  return Number(result.changes) > 0;
}

function deleteAuthSessionByToken(token) {
  const tokenHash = hashSessionToken(token);
  const result = deleteAuthSessionByTokenHashStmt.run(tokenHash);
  return Number(result.changes) > 0;
}

module.exports = {
  AUTH_SESSION_TTL_MS,
  normalizeEmail,
  toPublicUser,
  createUser,
  authenticateUser,
  createAuthSession,
  getAuthContextByToken,
  deleteAuthSessionById,
  deleteAuthSessionByToken,
  cleanupExpiredAuthSessions,
  comparePasswordConstantTime,
};
