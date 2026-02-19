const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');

const uploadsRoot = path.resolve(process.cwd(), 'data', 'uploads');
const tempUploadsRoot = path.join(uploadsRoot, '.tmp');
const MAX_UPLOAD_FILE_SIZE_BYTES = Number(process.env.MAX_UPLOAD_FILE_SIZE_BYTES) || 50 * 1024 * 1024;
const ALLOWED_PDF_MIME_TYPES = new Set(['application/pdf', 'application/x-pdf']);

function sanitizeFilename(filename) {
  return String(filename || 'upload.pdf')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_');
}

function isPathWithinUploadsRoot(candidatePath) {
  const resolvedPath = path.resolve(String(candidatePath || ''));
  return resolvedPath === uploadsRoot || resolvedPath.startsWith(`${uploadsRoot}${path.sep}`);
}

function createUploadPathError() {
  const error = new Error('File path is outside allowed uploads directory.');
  error.statusCode = 400;
  error.code = 'INVALID_UPLOAD_PATH';
  return error;
}

async function ensureSessionUploadDir(sessionId) {
  const dir = path.join(uploadsRoot, String(sessionId));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function ensureTempUploadDir() {
  await fs.mkdir(tempUploadsRoot, { recursive: true });
  return tempUploadsRoot;
}

async function readPdfSignature(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(5);
    await handle.read(buffer, 0, 5, 0);
    return buffer.toString('ascii');
  } finally {
    await handle.close();
  }
}

async function ensurePdfUploadFile(file) {
  const mimetype = String(file?.mimetype || '').toLowerCase();
  const originalname = String(file?.originalname || '').toLowerCase();
  const filePath = String(file?.path || '');
  const fileSize = Number(file?.size || 0);

  if (!filePath) {
    const error = new Error('Uploaded file path is missing.');
    error.statusCode = 400;
    error.code = 'MISSING_UPLOAD_FILE';
    throw error;
  }

  if (!ALLOWED_PDF_MIME_TYPES.has(mimetype)) {
    const error = new Error('Invalid MIME type. Only PDF uploads are allowed.');
    error.statusCode = 415;
    error.code = 'INVALID_FILE_MIME';
    throw error;
  }

  if (!originalname.endsWith('.pdf')) {
    const error = new Error('File extension must be .pdf.');
    error.statusCode = 400;
    error.code = 'INVALID_FILE_EXTENSION';
    throw error;
  }

  if (fileSize <= 0 || fileSize > MAX_UPLOAD_FILE_SIZE_BYTES) {
    const error = new Error('Uploaded file exceeds configured size limit.');
    error.statusCode = 400;
    error.code = 'UPLOAD_TOO_LARGE';
    throw error;
  }

  const signature = await readPdfSignature(filePath);
  if (signature !== '%PDF-') {
    const error = new Error('Invalid PDF file signature.');
    error.statusCode = 400;
    error.code = 'INVALID_FILE_SIGNATURE';
    throw error;
  }
}

async function moveFileExclusive(sourcePath, targetPath) {
  const normalizedSource = path.resolve(sourcePath);
  const normalizedTarget = path.resolve(targetPath);
  if (!isPathWithinUploadsRoot(normalizedSource) || !isPathWithinUploadsRoot(normalizedTarget)) {
    throw createUploadPathError();
  }

  try {
    await fs.access(normalizedTarget);
    const collisionError = new Error('PDF file collision detected. Retry upload.');
    collisionError.statusCode = 400;
    collisionError.code = 'UPLOAD_FILE_COLLISION';
    throw collisionError;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    await fs.rename(normalizedSource, normalizedTarget);
  } catch (error) {
    if (error?.code === 'EXDEV') {
      await fs.copyFile(normalizedSource, normalizedTarget, fsSync.constants.COPYFILE_EXCL);
      await fs.unlink(normalizedSource);
      return;
    }
    throw error;
  }
}

async function saveUploadedPdfById({ sessionId, pdfId, file }) {
  await ensurePdfUploadFile(file);

  const filename = `${pdfId}.pdf`;
  const sessionDir = await ensureSessionUploadDir(sessionId);
  const absolutePath = path.join(sessionDir, filename);

  if (!isPathWithinUploadsRoot(absolutePath)) {
    throw createUploadPathError();
  }

  await moveFileExclusive(file.path, absolutePath);

  return {
    filename,
    storagePath: absolutePath,
  };
}

async function removeStoredPdf(storagePath) {
  if (!isPathWithinUploadsRoot(storagePath)) {
    throw createUploadPathError();
  }

  await fs.unlink(path.resolve(storagePath));
}

async function removeTempUpload(tempFilePath) {
  if (!tempFilePath) {
    return;
  }

  const normalizedPath = path.resolve(tempFilePath);
  if (!isPathWithinUploadsRoot(normalizedPath)) {
    throw createUploadPathError();
  }

  await fs.unlink(normalizedPath).catch((error) => {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  });
}

async function cleanupTempUploadsOlderThan(maxAgeMs) {
  const threshold = Date.now() - Math.max(0, Number(maxAgeMs) || 0);
  await ensureTempUploadDir();

  const files = await fs.readdir(tempUploadsRoot).catch((error) => {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  });

  let removed = 0;
  for (const name of files) {
    const fullPath = path.join(tempUploadsRoot, name);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat || !stat.isFile()) {
      continue;
    }
    if (stat.mtimeMs < threshold) {
      await fs.unlink(fullPath).catch(() => null);
      removed += 1;
    }
  }

  return removed;
}

module.exports = {
  uploadsRoot,
  tempUploadsRoot,
  isPathWithinUploadsRoot,
  sanitizeFilename,
  ensureTempUploadDir,
  saveUploadedPdfById,
  removeStoredPdf,
  removeTempUpload,
  cleanupTempUploadsOlderThan,
};
