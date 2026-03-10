require('dotenv').config();

function toNumber(value, fallback, { min = null, max = null } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (min !== null && parsed < min) {
    return fallback;
  }
  if (max !== null && parsed > max) {
    return fallback;
  }
  return parsed;
}

function toBoolean(value, fallback = false) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return fallback;
}

function toList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const env = Object.freeze({
  nodeEnv: String(process.env.NODE_ENV || 'development').trim().toLowerCase(),
  port: toNumber(process.env.PORT, 4000, { min: 1, max: 65535 }),
  host: String(process.env.HOST || '0.0.0.0').trim(),
  dbPath: String(process.env.DB_PATH || 'data/studyrag.sqlite').trim(),
  trustProxy: toBoolean(process.env.TRUST_PROXY, false),
  corsAllowedOrigins: toList(process.env.CORS_ALLOWED_ORIGINS),
  maxRequestBodySizeBytes: toNumber(process.env.MAX_REQUEST_BODY_SIZE_BYTES, 2 * 1024 * 1024, { min: 1024 }),

  // Upload and parsing limits
  maxUploadFileSizeBytes: toNumber(process.env.MAX_UPLOAD_FILE_SIZE_BYTES, 30 * 1024 * 1024, { min: 1024 }),
  maxDocsPerSession: toNumber(process.env.MAX_DOCS_PER_SESSION, 5, { min: 1 }),
  maxPdfPages: toNumber(process.env.MAX_PDF_PAGES, 150, { min: 1 }),
  maxChunksPerQuery: toNumber(process.env.MAX_CHUNKS_PER_QUERY, 2000, { min: 1 }),
  maxExtractedTextLength: toNumber(process.env.MAX_EXTRACTED_TEXT_LENGTH, 2_000_000, { min: 1000 }),

  // RAG and embeddings
  ragTopK: toNumber(process.env.RAG_TOP_K, 5, { min: 1 }),
  ragCandidatePageSize: toNumber(process.env.RAG_CANDIDATE_PAGE_SIZE, 400, { min: 10 }),
  ragHistoryLimit: toNumber(process.env.RAG_HISTORY_LIMIT, 12, { min: 1 }),
  ragResponseStyle: String(process.env.RAG_RESPONSE_STYLE || 'structured').trim().toLowerCase(),
  ragChunkTokens: toNumber(process.env.RAG_CHUNK_TOKENS, 1000, { min: 100 }),
  ragOverlapTokens: toNumber(process.env.RAG_CHUNK_OVERLAP_TOKENS, 200, { min: 0 }),
  ragTokenToCharRatio: toNumber(process.env.RAG_TOKEN_TO_CHAR_RATIO, 4, { min: 1 }),
  localEmbeddingBatchSize: toNumber(process.env.LOCAL_EMBEDDING_BATCH_SIZE, 24, { min: 1 }),
  localEmbeddingBatchSizeMin: toNumber(process.env.LOCAL_EMBEDDING_BATCH_SIZE_MIN, 8, { min: 1 }),
  localEmbeddingBatchSizeMax: toNumber(process.env.LOCAL_EMBEDDING_BATCH_SIZE_MAX, 64, { min: 1 }),

  // Auth and sessions
  authLoginWindowMs: toNumber(process.env.AUTH_LOGIN_WINDOW_MS, 15 * 60 * 1000, { min: 1000 }),
  authLoginLockMs: toNumber(process.env.AUTH_LOGIN_LOCK_MS, 15 * 60 * 1000, { min: 1000 }),
  authLoginMaxFailures: toNumber(process.env.AUTH_LOGIN_MAX_FAILURES, 6, { min: 1 }),
  jwtSecret: String(
    process.env.JWT_SECRET
      || 'fallback-secret-for-dev-only-do-not-use-in-prod-12345'
  ).trim(),

  // Cleanup
  cleanupIntervalMs: toNumber(process.env.CLEANUP_INTERVAL_MS, 15 * 60 * 1000, { min: 1000 }),
  cleanupCompletedJobTtlHours: toNumber(process.env.CLEANUP_COMPLETED_JOB_TTL_HOURS, 24, { min: 0 }),
  cleanupFailedJobTtlHours: toNumber(process.env.CLEANUP_FAILED_JOB_TTL_HOURS, 72, { min: 0 }),
  cleanupTempFileTtlHours: toNumber(process.env.CLEANUP_TEMP_FILE_TTL_HOURS, 6, { min: 0 }),

  // Gemini
  geminiApiKey: String(process.env.GEMINI_API_KEY || '').trim(),
  geminiModel: String(process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim(),
});

module.exports = env;
