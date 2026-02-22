const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');

const uploadsRoot = path.resolve(process.cwd(), 'data', 'uploads');
const tempUploadsRoot = path.join(uploadsRoot, '.tmp');
const MAX_UPLOAD_FILE_SIZE_BYTES = Number(process.env.MAX_UPLOAD_FILE_SIZE_BYTES) || 50 * 1024 * 1024;

const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/csv',
  'application/pdf',
]);

const MIME_TO_FILE_TYPE = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/csv': 'csv',
  'application/pdf': 'pdf',
};

const FILE_TYPE_TO_EXTENSION = {
  txt: 'txt',
  md: 'md',
  docx: 'docx',
  csv: 'csv',
  pdf: 'pdf',
};

function sanitizeFilename(filename) {
  return String(filename || 'upload.bin')
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

function createUploadValidationError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
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

async function readFileSignature(filePath, byteLength = 8192) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(byteLength);
    const { bytesRead } = await handle.read(buffer, 0, byteLength, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isZipSignature(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return false;
  }

  const signature = buffer.subarray(0, 4);
  const zipSignatures = [
    Buffer.from([0x50, 0x4B, 0x03, 0x04]),
    Buffer.from([0x50, 0x4B, 0x05, 0x06]),
    Buffer.from([0x50, 0x4B, 0x07, 0x08]),
  ];

  return zipSignatures.some((candidate) => signature.equals(candidate));
}

function isLikelyUtf8Text(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return false;
  }

  if (buffer.includes(0x00)) {
    return false;
  }

  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return false;
  }

  let disallowedControlCount = 0;
  for (let i = 0; i < decoded.length; i += 1) {
    const code = decoded.charCodeAt(i);
    const isControl = code < 32;
    const isAllowedControl = code === 9 || code === 10 || code === 13 || code === 12;
    if (isControl && !isAllowedControl) {
      disallowedControlCount += 1;
    }
  }

  return disallowedControlCount === 0;
}

function detectSignatureType(signatureBuffer) {
  if (!Buffer.isBuffer(signatureBuffer) || signatureBuffer.length === 0) {
    return 'unknown';
  }

  if (signatureBuffer.length >= 5 && signatureBuffer.subarray(0, 5).toString('ascii') === '%PDF-') {
    return 'pdf';
  }

  if (isZipSignature(signatureBuffer)) {
    return 'zip';
  }

  if (isLikelyUtf8Text(signatureBuffer)) {
    return 'text';
  }

  return 'binary';
}

function assertTypeSignatureCompatibility(fileType, signatureType) {
  if (fileType === 'pdf' && signatureType !== 'pdf') {
    throw createUploadValidationError(400, 'INVALID_FILE_SIGNATURE', 'Invalid PDF file signature.');
  }

  if (fileType === 'docx' && signatureType !== 'zip') {
    throw createUploadValidationError(400, 'INVALID_FILE_SIGNATURE', 'Invalid DOCX file signature.');
  }

  if ((fileType === 'txt' || fileType === 'md' || fileType === 'csv') && signatureType !== 'text') {
    throw createUploadValidationError(400, 'INVALID_FILE_SIGNATURE', 'Invalid text file signature or encoding.');
  }
}

async function inspectUploadedFile(file) {
  const mimetype = String(file?.mimetype || '').toLowerCase().trim();
  const originalname = String(file?.originalname || 'upload.bin').toLowerCase().trim();
  const filePath = String(file?.path || '');
  const fileSize = Number(file?.size || 0);

  if (!filePath) {
    throw createUploadValidationError(400, 'MISSING_UPLOAD_FILE', 'Uploaded file path is missing.');
  }

  if (!ALLOWED_UPLOAD_MIME_TYPES.has(mimetype)) {
    throw createUploadValidationError(415, 'INVALID_FILE_MIME', 'Unsupported MIME type for uploaded file.');
  }

  if (fileSize <= 0 || fileSize > MAX_UPLOAD_FILE_SIZE_BYTES) {
    throw createUploadValidationError(400, 'UPLOAD_TOO_LARGE', 'Uploaded file exceeds configured size limit.');
  }

  const fileType = MIME_TO_FILE_TYPE[mimetype];
  if (!fileType) {
    throw createUploadValidationError(415, 'INVALID_FILE_MIME', 'Unsupported MIME type for uploaded file.');
  }

  const signatureBuffer = await readFileSignature(filePath);
  const signatureType = detectSignatureType(signatureBuffer);
  assertTypeSignatureCompatibility(fileType, signatureType);

  const extension = FILE_TYPE_TO_EXTENSION[fileType];
  if (!extension) {
    throw createUploadValidationError(415, 'UNSUPPORTED_FILE_TYPE', 'Unsupported uploaded file type.');
  }

  return {
    fileType,
    extension,
    mimetype,
    originalname,
    signatureType,
    fileSize,
  };
}

async function moveFileExclusive(sourcePath, targetPath) {
  const normalizedSource = path.resolve(sourcePath);
  const normalizedTarget = path.resolve(targetPath);
  if (!isPathWithinUploadsRoot(normalizedSource) || !isPathWithinUploadsRoot(normalizedTarget)) {
    throw createUploadPathError();
  }

  try {
    await fs.access(normalizedTarget);
    const collisionError = new Error('File collision detected. Retry upload.');
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

async function saveUploadedFileById({ sessionId, pdfId, file, detectedFile = null }) {
  const inspected = detectedFile || await inspectUploadedFile(file);

  const filename = `${pdfId}.${inspected.extension}`;
  const sessionDir = await ensureSessionUploadDir(sessionId);
  const absolutePath = path.join(sessionDir, filename);

  if (!isPathWithinUploadsRoot(absolutePath)) {
    throw createUploadPathError();
  }

  await moveFileExclusive(file.path, absolutePath);

  return {
    filename,
    storagePath: absolutePath,
    fileType: inspected.fileType,
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
  MAX_UPLOAD_FILE_SIZE_BYTES,
  ALLOWED_UPLOAD_MIME_TYPES,
  isPathWithinUploadsRoot,
  sanitizeFilename,
  ensureTempUploadDir,
  inspectUploadedFile,
  saveUploadedFileById,
  // Backward-compatible alias while route names still reference PDFs.
  saveUploadedPdfById: saveUploadedFileById,
  removeStoredPdf,
  removeTempUpload,
  cleanupTempUploadsOlderThan,
};
