const { cleanupJobs } = require('./jobQueue');
const { cleanupTempUploadsOlderThan } = require('./uploadService');
const { cleanupOrphanChunks } = require('./vectorService');
const { cleanupExpiredAuthSessions } = require('./authService');
const { logInfo, logError } = require('../config/logger');
const env = require('../config/env');

const DEFAULT_CLEANUP_INTERVAL_MS = env.cleanupIntervalMs;
const DEFAULT_COMPLETED_JOB_TTL_HOURS = env.cleanupCompletedJobTtlHours;
const DEFAULT_FAILED_JOB_TTL_HOURS = env.cleanupFailedJobTtlHours;
const DEFAULT_TEMP_FILE_TTL_HOURS = env.cleanupTempFileTtlHours;

let cleanupTimer = null;
let cleanupRunning = false;

function hoursToMs(hours) {
  return Math.max(0, Number(hours) || 0) * 60 * 60 * 1000;
}

async function runCleanupCycle() {
  if (cleanupRunning) {
    return { skipped: true };
  }

  cleanupRunning = true;
  try {
    const jobs = cleanupJobs({
      completedOlderThanMs: hoursToMs(DEFAULT_COMPLETED_JOB_TTL_HOURS),
      failedOlderThanMs: hoursToMs(DEFAULT_FAILED_JOB_TTL_HOURS),
    });
    const removedTempFiles = await cleanupTempUploadsOlderThan(hoursToMs(DEFAULT_TEMP_FILE_TTL_HOURS));
    const removedOrphanChunks = cleanupOrphanChunks();
    const removedAuthSessions = cleanupExpiredAuthSessions();

    const payload = {
      jobsCompletedDeleted: jobs.completedDeleted,
      jobsFailedDeleted: jobs.failedDeleted,
      jobsMemoryDeleted: jobs.memoryDeleted,
      removedTempFiles,
      removedOrphanChunks,
      removedAuthSessions,
    };
    logInfo('CLEANUP_DONE', payload);
    return payload;
  } catch (error) {
    logError('ERROR_QUEUE', error, {
      service: 'cleanupService',
      stage: 'runCleanupCycle',
    });
    return { failed: true };
  } finally {
    cleanupRunning = false;
  }
}

function startCleanupWorker() {
  if (cleanupTimer) {
    return cleanupTimer;
  }

  runCleanupCycle().catch(() => null);
  cleanupTimer = setInterval(() => {
    runCleanupCycle().catch(() => null);
  }, DEFAULT_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
  return cleanupTimer;
}

module.exports = {
  runCleanupCycle,
  startCleanupWorker,
};
