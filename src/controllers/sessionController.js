const {
    listSessions,
    searchSessionsByTitle,
    createSession,
    renameSession,
    getSessionMetadata,
    assertSessionExists,
    deleteSession,
} = require('../services/sessionService');
const { listPdfsBySession } = require('../services/pdfRecordService');
const { removeJobsFromMemory } = require('../services/jobQueue');
const { removeStoredPdf } = require('../services/uploadService');
const { parsePositiveInt } = require('../utils/helpers');
const { ok } = require('../routes/helpers');
const { logError } = require('../config/logger');

async function getAllSessions(req, res) {
    return ok(res, listSessions(req.user.id));
}

async function createNewSession(req, res) {
    const title = req.body.title || 'NewChat';
    const session = createSession(req.user.id, title);
    return ok(res, session);
}

async function searchSessions(req, res) {
    const query = String(req.query.q || '').trim();
    if (!query) {
        return ok(res, []);
    }
    return ok(res, searchSessionsByTitle(req.user.id, query, { limit: 50 }));
}

async function renameExistingSession(req, res) {
    const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
    const session = renameSession(sessionId, req.user.id, req.body.title);
    return ok(res, session);
}

async function getMetadata(req, res) {
    const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
    return ok(res, getSessionMetadata(sessionId, req.user.id));
}

async function getSession(req, res) {
    const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
    const session = assertSessionExists(sessionId, req.user.id);
    const pdfs = listPdfsBySession(sessionId, req.user.id);
    return ok(res, { ...session, pdfs });
}

async function deleteSessionHandler(req, res) {
    const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
    const result = deleteSession(sessionId, req.user.id);
    removeJobsFromMemory(result.deletedJobIds);

    for (const storagePath of result.deletedPdfPaths) {
        await removeStoredPdf(storagePath).catch((error) => {
            if (error?.code === 'ENOENT') {
                return;
            }
            logError('ERROR_UPLOAD', error, {
                route: '/api/v1/sessions/:sessionId',
                sessionId,
                stage: 'removeSessionPdfFile',
            });
        });
    }

    return ok(res, { deleted: true, id: result.id });
}

module.exports = {
    getAllSessions,
    createNewSession,
    searchSessions,
    renameExistingSession,
    getMetadata,
    getSession,
    deleteSessionHandler
};
