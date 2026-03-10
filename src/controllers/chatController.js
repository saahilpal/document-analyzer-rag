const { assertSessionExists } = require('../services/sessionService');
const { getPdfReadinessBySession } = require('../services/pdfRecordService');
const {
    runChatQuery,
    runChatQueryStream,
    shouldRunAsyncChat,
    normalizeResponseStyle,
    generateSessionTitle,
} = require('../services/ragService');
const { addMessage, listSessionHistory, clearSessionHistory } = require('../services/chatHistoryService');
const { recordQuery } = require('../services/metricsService');
const { addJob, getQueuePosition } = require('../services/jobQueue');
const { parsePositiveInt, validateHistory } = require('../utils/helpers');
const { initSse, writeSseEvent, shouldStreamChat } = require('../utils/sse');
const { createHttpError, normalizeHttpError } = require('../utils/errors');
const { ok, fail } = require('../routes/helpers');
const { logInfo, logError } = require('../config/logger');
const { renameSession } = require('../services/sessionService');
const { listPdfsBySession } = require('../services/pdfRecordService');

// Mutex mapping for session titles during stream
const titleMutexes = new Map();

async function withSessionLock(sessionId, fn) {
    const prevPromise = titleMutexes.get(sessionId) || Promise.resolve();
    const nextPromise = prevPromise.then(fn).catch(err => {
        // Rely on inner catch for logging
    });
    titleMutexes.set(sessionId, nextPromise);
    nextPromise.finally(() => {
        if (titleMutexes.get(sessionId) === nextPromise) {
            titleMutexes.delete(sessionId);
        }
    });
    return nextPromise;
}

async function postChat(req, res) {
    const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
    const session = assertSessionExists(sessionId, req.user.id);
    const message = req.body.message.trim();
    const { history } = req.body;
    const responseStyle = normalizeResponseStyle(req.body.responseStyle);

    const normalizedHistory = validateHistory(history);
    const readiness = getPdfReadinessBySession(sessionId, req.user.id);
    if (readiness.uploaded === 0 || readiness.indexed === 0 || readiness.processing > 0 || readiness.failed > 0) {
        return fail(
            res,
            createHttpError(400, 'PDF_NOT_READY', 'Documents still processing or failed indexing.', {
                retryable: readiness.processing > 0,
            }),
            400
        );
    }

    logInfo('CHAT_REQUEST', {
        route: '/api/v1/sessions/:sessionId/chat',
        sessionId,
        messageLength: message.length,
    });

    try {
        addMessage({
            userId: req.user.id,
            sessionId,
            role: 'user',
            text: message,
        });
    } catch (error) {
        logError('ERROR_DB', error, {
            route: '/api/v1/sessions/:sessionId/chat',
            sessionId,
            stage: 'saveUserMessage',
        });
    }

    if (shouldStreamChat(req)) {
        initSse(res);
        let clientDisconnected = false;
        req.on('aborted', () => {
            clientDisconnected = true;
        });
        res.on('close', () => {
            if (!res.writableEnded) {
                clientDisconnected = true;
            }
        });

        const emitEvent = (event, payload) => {
            if (clientDisconnected || res.writableEnded) {
                return;
            }
            writeSseEvent(res, event, payload);
        };

        emitEvent('ready', {
            ok: true,
            data: {
                sessionId,
                status: 'streaming',
            },
        });

        try {
            const response = await runChatQueryStream({
                sessionId,
                message,
                history: normalizedHistory,
                responseStyle,
            }, {
                onProgress: ({ stage, progress }) => {
                    emitEvent('progress', {
                        ok: true,
                        data: { stage, progress },
                    });
                },
                onToken: (token) => {
                    emitEvent('token', {
                        ok: true,
                        data: { token },
                    });
                },
            });

            if (!clientDisconnected) {
                try {
                    addMessage({
                        userId: req.user.id,
                        sessionId,
                        role: 'assistant',
                        text: response.answer,
                    });
                } catch (error) {
                    logError('ERROR_DB', error, {
                        route: '/api/v1/sessions/:sessionId/chat',
                        sessionId,
                        stage: 'streamPersistMessage',
                    });
                }
            }

            let finalSessionTitle = session.title;
            if (session.title === 'NewChat') {
                await withSessionLock(sessionId, async () => {
                    try {
                        // Re-fetch session to ensure it wasn't renamed while we waited
                        const currentSession = assertSessionExists(sessionId, req.user.id);
                        if (currentSession.title !== 'NewChat') {
                            finalSessionTitle = currentSession.title;
                            return;
                        }

                        const pdfs = listPdfsBySession(sessionId, req.user.id);
                        const firstPdfTitle = pdfs && pdfs.length > 0 ? pdfs[0].title : null;
                        const newTitle = await generateSessionTitle(message, firstPdfTitle);
                        if (newTitle) {
                            renameSession(sessionId, req.user.id, newTitle);
                            finalSessionTitle = newTitle;
                        }
                    } catch (titleError) {
                        logError('ERROR_TITLE_GEN_STREAM', titleError, { sessionId });
                    }
                });
            }

            emitEvent('done', {
                ok: true,
                data: {
                    answer: response.answer,
                    formattedAnswer: response.formattedAnswer,
                    responseSchema: response.responseSchema,
                    responseStyle: response.responseStyle,
                    sources: response.sources,
                    usedChunksCount: response.usedChunksCount,
                    sessionTitle: finalSessionTitle,
                    fallback: response.fallback,
                },
            });
        } catch (error) {
            const normalized = normalizeHttpError(error);
            emitEvent('error', {
                ok: false,
                error: normalized.error,
            });
        } finally {
            if (!res.writableEnded) {
                res.end();
            }
        }
        return;
    }

    if (shouldRunAsyncChat({ sessionId, history: normalizedHistory })) {
        const job = addJob({
            type: 'chatQuery',
            userId: req.user.id,
            sessionId,
            message,
            history: normalizedHistory,
            responseStyle,
            maxRetries: 1,
        });

        return ok(res, {
            jobId: job.id,
            sessionId,
            status: 'processing',
            responseStyle,
            progress: job.progress,
            stage: job.stage,
            queuePosition: getQueuePosition(job.id),
        }, 202);
    }

    const startedAt = Date.now();
    const response = await runChatQuery({
        sessionId,
        message,
        history: normalizedHistory,
        responseStyle,
    });
    const durationMs = Date.now() - startedAt;
    recordQuery({ queryTimeMs: durationMs });
    try {
        addMessage({
            userId: req.user.id,
            sessionId,
            role: 'assistant',
            text: response.answer,
        });
    } catch (error) {
        logError('ERROR_DB', error, {
            route: '/api/v1/sessions/:sessionId/chat',
            sessionId,
        });
    }

    let finalSessionTitle = session.title;
    if (session.title === 'NewChat') {
        await withSessionLock(sessionId, async () => {
            try {
                const currentSession = assertSessionExists(sessionId, req.user.id);
                if (currentSession.title !== 'NewChat') {
                    finalSessionTitle = currentSession.title;
                    return;
                }

                const pdfs = listPdfsBySession(sessionId, req.user.id);
                const firstPdfTitle = pdfs && pdfs.length > 0 ? pdfs[0].title : null;
                const newTitle = await generateSessionTitle(message, firstPdfTitle);
                if (newTitle) {
                    renameSession(sessionId, req.user.id, newTitle);
                    finalSessionTitle = newTitle;
                }
            } catch (titleError) {
                logError('ERROR_TITLE_GEN_SYNC', titleError, { sessionId });
            }
        });
    }

    return ok(res, {
        answer: response.answer,
        formattedAnswer: response.formattedAnswer,
        responseSchema: response.responseSchema,
        responseStyle: response.responseStyle,
        sources: response.sources,
        usedChunksCount: response.usedChunksCount,
        sessionTitle: finalSessionTitle,
        fallback: response.fallback,
    });
}

async function getChatHistory(req, res) {
    const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
    assertSessionExists(sessionId, req.user.id);
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;
    return ok(res, listSessionHistory(sessionId, req.user.id, { limit, offset }));
}

async function emptyChatHistory(req, res) {
    const sessionId = parsePositiveInt(req.params.sessionId, 'sessionId');
    assertSessionExists(sessionId, req.user.id);
    const result = clearSessionHistory(sessionId, req.user.id);
    return ok(res, result);
}

module.exports = {
    postChat,
    getChatHistory,
    emptyChatHistory
};
