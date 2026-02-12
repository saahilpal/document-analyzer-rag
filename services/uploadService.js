const fs = require('fs/promises');
const path = require('path');

const uploadsRoot = path.join(process.cwd(), 'data', 'uploads');

function sanitizeFilename(filename) {
  return String(filename || 'file.pdf')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_');
}

function ensurePdfMime(file) {
  const mimetype = String(file?.mimetype || '').toLowerCase();
  const originalname = String(file?.originalname || '').toLowerCase();

  if (mimetype !== 'application/pdf' && !originalname.endsWith('.pdf')) {
    const error = new Error('Only PDF files are allowed.');
    error.statusCode = 400;
    throw error;
  }
}

async function ensureSessionUploadDir(sessionId) {
  const dir = path.join(uploadsRoot, String(sessionId));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function saveUploadedPdf({ sessionId, file }) {
  ensurePdfMime(file);

  const safeOriginalName = sanitizeFilename(file.originalname || 'upload.pdf');
  const uniqueName = `${Date.now()}_${safeOriginalName}`;
  const sessionDir = await ensureSessionUploadDir(sessionId);
  const absolutePath = path.join(sessionDir, uniqueName);

  await fs.writeFile(absolutePath, file.buffer);

  return {
    filename: uniqueName,
    storagePath: absolutePath,
  };
}

async function removeStoredPdf(storagePath) {
  await fs.unlink(storagePath);
}

module.exports = {
  uploadsRoot,
  sanitizeFilename,
  saveUploadedPdf,
  removeStoredPdf,
};
