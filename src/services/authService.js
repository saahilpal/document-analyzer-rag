const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/database');
const { createHttpError } = require('../utils/errors');
const { sendEmail } = require('./emailService');

const AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OTP_TTL_MS = 5 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;
const AUTH_SESSION_CLEANUP_INTERVAL_MS = 60 * 1000;
const BCRYPT_ROUNDS = 12;

const LOGIN_WINDOW_MS = Number(process.env.AUTH_LOGIN_WINDOW_MS) || 15 * 60 * 1000;
const LOGIN_LOCK_MS = Number(process.env.AUTH_LOGIN_LOCK_MS) || 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = Number(process.env.AUTH_LOGIN_MAX_FAILURES) || 6;

const DUMMY_PASSWORD_HASH = bcrypt.hashSync('invalid-password-placeholder', BCRYPT_ROUNDS);
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-for-dev-only-do-not-use-in-prod-12345';

let lastSessionCleanupAt = 0;

const insertUserStmt = db.prepare(`
  INSERT INTO users (name, email, password_hash, created_at, updated_at, is_active)
  VALUES (@name, @email, @passwordHash, @createdAt, @updatedAt, @isActive)
`);

const getUserByIdStmt = db.prepare(`
  SELECT id, name, email, password_hash AS passwordHash, created_at AS createdAt, updated_at AS updatedAt, is_active AS isActive FROM users WHERE id = ?
`);

const getUserByEmailStmt = db.prepare(`
  SELECT id, name, email, password_hash AS passwordHash, created_at AS createdAt, updated_at AS updatedAt, is_active AS isActive FROM users WHERE email = ?
`);

const insertAuthSessionStmt = db.prepare(`
  INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at, device_info, ip_address, last_used_at)
  VALUES (@id, @userId, @tokenHash, @expiresAt, @createdAt, @deviceInfo, @ipAddress, @lastUsedAt)
`);

const getAuthSessionByTokenHashStmt = db.prepare(`
  SELECT s.id AS sessionId, s.user_id AS sessionUserId, s.expires_at AS expiresAt, u.id, u.name, u.email, u.password_hash AS passwordHash, u.created_at AS createdAt, u.updated_at AS updatedAt, u.is_active AS isActive FROM auth_sessions s INNER JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? LIMIT 1
`);

const deleteAuthSessionByIdStmt = db.prepare(`DELETE FROM auth_sessions WHERE id = ?`);
const deleteAuthSessionByTokenHashStmt = db.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`);
const deleteExpiredAuthSessionsStmt = db.prepare(`DELETE FROM auth_sessions WHERE expires_at <= ?`);

const insertRefreshTokenStmt = db.prepare(`
  INSERT INTO refresh_tokens (user_id, token_hash, expires_at, created_at)
  VALUES (@userId, @tokenHash, @expiresAt, @createdAt)
`);

const getRefreshTokenStmt = db.prepare(`
  SELECT id, user_id, expires_at FROM refresh_tokens WHERE token_hash = ? AND expires_at > ? LIMIT 1
`);

const deleteRefreshTokenStmt = db.prepare(`DELETE FROM refresh_tokens WHERE id = ?`);

const insertOtpStmt = db.prepare(`
  INSERT INTO email_otps (email, otp_hash, expires_at, attempts, type, created_at)
  VALUES (@email, @otpHash, @expiresAt, 0, @type, @createdAt)
`);

const getOtpStmt = db.prepare(`
  SELECT id, otp_hash, attempts, expires_at FROM email_otps WHERE email = ? AND type = ? ORDER BY id DESC LIMIT 1
`);

const incrementOtpAttemptStmt = db.prepare(`UPDATE email_otps SET attempts = attempts + 1 WHERE id = ?`);
const lockOtpStmt = db.prepare(`UPDATE email_otps SET attempts = 999 WHERE id = ?`);

const insertPasswordResetStmt = db.prepare(`
  INSERT INTO password_resets (user_id, token_hash, expires_at, created_at)
  VALUES (@userId, @tokenHash, @expiresAt, @createdAt)
`);

const getPasswordResetStmt = db.prepare(`
  SELECT id, user_id, expires_at FROM password_resets WHERE token_hash = ? AND expires_at > ? LIMIT 1
`);

const deletePasswordResetStmt = db.prepare(`DELETE FROM password_resets WHERE id = ?`);

const getLoginAttemptStmt = db.prepare(`
  SELECT id, attempts, locked_until, window_start FROM login_attempts WHERE email = ? AND ip_address = ? LIMIT 1
`);

const insertLoginAttemptStmt = db.prepare(`
  INSERT INTO login_attempts (email, ip_address, attempts, locked_until, window_start)
  VALUES (@email, @ipAddress, @attempts, @lockedUntil, @windowStart)
`);

const updateLoginAttemptStmt = db.prepare(`
  UPDATE login_attempts SET attempts = @attempts, locked_until = @lockedUntil, window_start = @windowStart WHERE id = @id
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
    isActive: Boolean(user.isActive),
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
  db.prepare(`DELETE FROM login_attempts WHERE locked_until <= ? AND window_start <= ?`).run(now, now - LOGIN_WINDOW_MS);
}

function assertLoginAllowed(email, ipAddress) {
  const now = Date.now();
  const normalizedEmail = normalizeEmail(email);
  const normalizedIp = sanitizeString(ipAddress, 120) || 'unknown';

  const attempt = getLoginAttemptStmt.get(normalizedEmail, normalizedIp);
  if (attempt && attempt.locked_until > now) {
    const error = createHttpError(429, 'INVALID_CREDENTIALS', 'Invalid email or password.', { retryable: true });
    error.retryAfterSeconds = Math.ceil((attempt.locked_until - now) / 1000);
    throw error;
  }
}

function markFailedLogin(email, ipAddress) {
  const now = Date.now();
  const normalizedEmail = normalizeEmail(email);
  const normalizedIp = sanitizeString(ipAddress, 120) || 'unknown';

  const attempt = getLoginAttemptStmt.get(normalizedEmail, normalizedIp);
  if (!attempt) {
    insertLoginAttemptStmt.run({ email: normalizedEmail, ipAddress: normalizedIp, attempts: 1, lockedUntil: 0, windowStart: now });
    return;
  }

  let attempts = attempt.attempts + 1;
  let lockedUntil = attempt.locked_until;
  let windowStart = attempt.window_start;

  if (now - windowStart > LOGIN_WINDOW_MS) {
    attempts = 1;
    windowStart = now;
  }

  if (attempts >= LOGIN_MAX_FAILURES) {
    attempts = 0;
    windowStart = now;
    lockedUntil = now + LOGIN_LOCK_MS;
  }

  updateLoginAttemptStmt.run({ id: attempt.id, attempts, lockedUntil, windowStart });
}

function clearFailedLogin(email, ipAddress) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedIp = sanitizeString(ipAddress, 120) || 'unknown';
  db.prepare(`DELETE FROM login_attempts WHERE email = ? AND ip_address = ?`).run(normalizedEmail, normalizedIp);
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

  let user = getUserByEmail(normalizedEmail);
  if (user) {
    return user;
  }

  try {
    const result = insertUserStmt.run({
      name: normalizedName,
      email: normalizedEmail,
      passwordHash,
      createdAt: now,
      updatedAt: now,
      isActive: 0
    });

    user = getUserById(Number(result.lastInsertRowid));
    if (!user) {
      throw createHttpError(500, 'INTERNAL_ERROR', 'Unable to register with provided credentials.');
    }
    return user;
  } catch (error) {
    if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
      return getUserByEmail(normalizedEmail);
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

function generateJwtToken(payload, expiresIn) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

function createJWTAuthSession({ userId, deviceInfo, ipAddress }) {
  const normalizedUserId = Number(userId);
  if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) {
    throw createHttpError(400, 'INVALID_USER_ID', 'Invalid auth session user.', { retryable: false });
  }

  maybeCleanupExpiredAuthSessions();

  const sessionId = crypto.randomUUID();
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + AUTH_SESSION_TTL_MS).toISOString();

  insertAuthSessionStmt.run({
    id: sessionId,
    userId: normalizedUserId,
    tokenHash,
    expiresAt,
    createdAt,
    deviceInfo: sanitizeString(deviceInfo),
    ipAddress: sanitizeString(ipAddress, 120),
    lastUsedAt: createdAt
  });

  const accessToken = generateJwtToken({ userId: normalizedUserId, sessionId }, '15m');

  const rawRefreshToken = generateSessionToken();
  const refreshTokenHash = hashSessionToken(rawRefreshToken);
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString();

  insertRefreshTokenStmt.run({
    userId: normalizedUserId,
    tokenHash: refreshTokenHash,
    expiresAt: refreshExpiresAt,
    createdAt
  });

  return { accessToken, refreshToken: rawRefreshToken, expiresAt, sessionId };
}

function getAuthContextByToken(token) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) return null;

  maybeCleanupExpiredAuthSessions();

  try {
    const payload = jwt.verify(normalizedToken, JWT_SECRET);

    // Retrieve the database record matched strictly against the stored sessionId 
    // (The session itself was natively verified via HS256 JWT signature above)
    const sessionStmt = db.prepare(`
        SELECT s.id AS sessionId, s.expires_at AS expiresAt, u.id, u.name, u.email, u.created_at AS createdAt, u.updated_at AS updatedAt, u.is_active AS isActive FROM auth_sessions s INNER JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ? LIMIT 1
     `);

    const row = sessionStmt.get(payload.sessionId, new Date().toISOString());
    if (!row) return null;

    return {
      sessionId: row.sessionId,
      expiresAt: row.expiresAt,
      user: toPublicUser(row),
    };
  } catch (err) {
    return null;
  }
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

async function requestOTP(email, type) {
  const normalizedEmail = normalizeEmail(email);
  const otp = crypto.randomInt(100000, 999999).toString();
  const otpHash = await hashPassword(otp);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

  insertOtpStmt.run({ email: normalizedEmail, otpHash, expiresAt, type, createdAt: new Date().toISOString() });

  if (type === 'register') await sendEmail('verify', { to: normalizedEmail, otp });
  if (type === 'change_email') await sendEmail('email-change', { to: normalizedEmail, otp });
}

async function verifyOTP(email, type, otp) {
  const normalizedEmail = normalizeEmail(email);
  const record = getOtpStmt.get(normalizedEmail, type);

  if (!record || new Date(record.expires_at) < new Date()) {
    throw createHttpError(400, 'INVALID_OTP', 'OTP invalid or expired.');
  }

  if (record.attempts >= 5) {
    throw createHttpError(400, 'INVALID_OTP', 'Too many attempts.');
  }

  const isValid = await comparePasswordConstantTime(otp, record.otp_hash);
  if (!isValid) {
    incrementOtpAttemptStmt.run(record.id);
    throw createHttpError(400, 'INVALID_OTP', 'OTP invalid or expired.');
  }

  lockOtpStmt.run(record.id);
  return true;
}

async function rotateRefreshToken(oldRefreshToken, ipAddress) {
  const tokenHash = hashSessionToken(oldRefreshToken);
  const nowStr = new Date().toISOString();
  const row = getRefreshTokenStmt.get(tokenHash, nowStr);

  if (!row) {
    throw createHttpError(401, 'INVALID_TOKEN', 'Session expired. Please log in again.');
  }

  deleteRefreshTokenStmt.run(row.id);

  const user = getUserById(row.user_id);
  if (!user || user.isActive === 0) {
    throw createHttpError(401, 'UNAUTHORIZED', 'Account unavailable.');
  }

  return createJWTAuthSession({ userId: user.id, deviceInfo: 'Refresh Rotation', ipAddress });
}

async function requestPasswordReset(email) {
  const normalizedEmail = normalizeEmail(email);
  const user = getUserByEmail(normalizedEmail);
  if (!user) return; // Silent explicitly

  const rawToken = generateSessionToken();
  const tokenHash = hashSessionToken(rawToken);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();

  insertPasswordResetStmt.run({ userId: user.id, tokenHash, expiresAt, createdAt: new Date().toISOString() });
  await sendEmail('reset', { to: normalizedEmail, token: rawToken });
}

async function executePasswordReset(token, newPassword) {
  const tokenHash = hashSessionToken(token);
  const nowStr = new Date().toISOString();
  const row = getPasswordResetStmt.get(tokenHash, nowStr);

  if (!row) {
    throw createHttpError(400, 'INVALID_TOKEN', 'Reset token invalid or expired.');
  }

  deletePasswordResetStmt.run(row.id);

  const passwordHash = await hashPassword(newPassword);
  db.prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`).run(passwordHash, new Date().toISOString(), row.user_id);

  const user = getUserById(row.user_id);
  if (user && user.email) {
    await sendEmail('reset-success', { to: user.email });
  }

  // Nuke sessions to force re-login on all devices
  db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(row.user_id);
  db.prepare(`DELETE FROM refresh_tokens WHERE user_id = ?`).run(row.user_id);
}

function updateAuthSessionLastUsed(sessionId) {
  db.prepare(`UPDATE auth_sessions SET last_used_at = ? WHERE id = ?`).run(new Date().toISOString(), sessionId);
}

function activateUser(email) {
  db.prepare(`UPDATE users SET is_active = 1, updated_at = ? WHERE email = ?`).run(new Date().toISOString(), normalizeEmail(email));
}

function updateUserEmail(userId, newEmail) {
  db.prepare(`UPDATE users SET email = ?, updated_at = ? WHERE id = ?`).run(normalizeEmail(newEmail), new Date().toISOString(), userId);
}

module.exports = {
  AUTH_SESSION_TTL_MS,
  normalizeEmail,
  toPublicUser,
  createUser,
  authenticateUser,
  createJWTAuthSession,
  getAuthContextByToken,
  deleteAuthSessionById,
  deleteAuthSessionByToken,
  cleanupExpiredAuthSessions,
  comparePasswordConstantTime,
  requestOTP,
  verifyOTP,
  rotateRefreshToken,
  requestPasswordReset,
  executePasswordReset,
  updateAuthSessionLastUsed,
  activateUser,
  updateUserEmail,
  JWT_SECRET,
  getUserById,
  getUserByEmail
};
