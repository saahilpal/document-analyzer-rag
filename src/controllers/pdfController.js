const {
    assertPdfExists,
    deletePdfRecord,
    listPdfsBySession,
    createPdfRecord,
    updatePdfStorage,
    getPdfReadinessBySession
} = require('../services/pdfRecordService');
const { assertSessionExists } = require('../services/sessionService');
const {
    inspectUploadedFile,
    saveUploadedFileById,
    removeStoredPdf,
    removeTempUpload
} = require('../services/uploadService');
const { addJob, getQueuePosition } = require('../services/jobQueue');
const { parsePositiveInt, normalizeOptionalTitle } = require('../utils/helpers');
const { createHttpError } = require('../utils/errors');
const { ok } = require('../routes/helpers');
const { logInfo, logError } = require('../config/logger');
const env = require('../config/env');

async function uploadPdf(req, res, next) {
    let tempFilePath = '';
    try {
        const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
        assertSessionExists(sessionId, req.user.id);

        if (!req.file) {
            throw createHttpError(400, 'MISSING_UPLOAD_FILE', 'file is required as multipart form-data.');
        }

        const readiness = getPdfReadinessBySession(sessionId, req.user.id);
        const totalPdfs = readiness.uploaded + readiness.processing + readiness.indexed + readiness.failed;
        if (totalPdfs >= env.maxDocsPerSession) {
            logInfo('LIMIT_REACHED', {
                event: 'Session document limit reached',
                sessionId
            });
            throw createHttpError(
                403,
                'SESSION_DOC_LIMIT',
                `Free plan allows up to ${env.maxDocsPerSession} documents per session. Upgrade to premium to upload more.`
            );
        }

        tempFilePath = req.file.path;

        logInfo('UPLOAD_START', {
            route: '/api/v1/sessions/:sessionId/pdfs',
            sessionId,
            originalName: req.file.originalname,
            fileSize: req.file.size,
        });

        const detectedFile = await inspectUploadedFile(req.file);

        const pdf = createPdfRecord({
            userId: req.user.id,
            sessionId,
            title: normalizeOptionalTitle(req.body.title, req.file.originalname),
            filename: `pending.${detectedFile.extension}`,
            storagePath: '',
            type: detectedFile.fileType,
        });

        try {
            const { filename, storagePath } = await saveUploadedFileById({
                sessionId,
                pdfId: pdf.id,
                file: req.file,
                detectedFile,
            });

            updatePdfStorage(pdf.id, { filename, storagePath });
        } catch (error) {
            logError('ERROR_UPLOAD', error, {
                route: '/api/v1/sessions/:sessionId/pdfs',
                sessionId,
            });
            deletePdfRecord(pdf.id, req.user.id);
            throw error;
        }

        const indexJob = addJob({
            type: 'indexPdf',
            userId: req.user.id,
            pdfId: pdf.id,
            maxRetries: 3,
        });

        return ok(res, {
            pdfId: pdf.id,
            sessionId,
            title: pdf.title,
            status: 'processing',
            jobId: indexJob.id,
            progress: indexJob.progress,
            stage: indexJob.stage,
            queuePosition: getQueuePosition(indexJob.id),
        }, 202);
    } catch (error) {
        await removeTempUpload(tempFilePath).catch((cleanupError) => {
            logError('ERROR_UPLOAD', cleanupError, {
                route: '/api/v1/sessions/:sessionId/pdfs',
                stage: 'cleanupTempUpload',
            });
        });
        return next(error);
    }
}

async function getPdf(req, res) {
    const pdfId = parsePositiveInt(req.params.pdfId, 'pdfId');
    const pdf = assertPdfExists(pdfId, req.user.id);
    return ok(res, pdf);
}

async function deletePdf(req, res) {
    const pdfId = parsePositiveInt(req.params.pdfId, 'pdfId');
    const removeFile = String(req.query.removeFile || 'false').toLowerCase() === 'true';

    const pdf = assertPdfExists(pdfId, req.user.id);
    if (removeFile) {
        try {
            await removeStoredPdf(pdf.path);
        } catch (error) {
            logError('ERROR_UPLOAD', error, {
                route: '/api/v1/pdfs/:pdfId',
                pdfId,
            });
        }
    }

    const result = deletePdfRecord(pdfId, req.user.id);
    return ok(res, result);
}

async function getSessionPdfs(req, res) {
    const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
    assertSessionExists(sessionId, req.user.id);
    return ok(res, listPdfsBySession(sessionId, req.user.id));
}

module.exports = {
    uploadPdf,
    getPdf,
    deletePdf,
    getSessionPdfs
};
