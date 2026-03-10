const express = require('express');
const {
    getAllSessions,
    createNewSession,
    searchSessions,
    renameExistingSession,
    getMetadata,
    getSession,
    deleteSessionHandler
} = require('../../../controllers/sessionController');
const {
    uploadPdf,
    getSessionPdfs
} = require('../../../controllers/pdfController');
const {
    postChat,
    getChatHistory,
    emptyChatHistory
} = require('../../../controllers/chatController');
const {
    createSessionBodySchema,
    renameSessionBodySchema,
    sessionSearchQuerySchema
} = require('../../../validations/sessionSchemas');
const { chatBodySchema, historyQuerySchema } = require('../../../validations/chatSchemas');

const validateSchema = require('../../../middleware/validate');
const requireAuth = require('../../../middleware/requireAuth');
const asyncHandler = require('../../../utils/asyncHandler');
const multer = require('multer');
const { ensureTempUploadDir, sanitizeFilename } = require('../../../services/uploadService');
const { strictReadLimiter, writeLimiter, uploadLimiter, chatLimiter } = require('../../../middleware/limiters');
const env = require('../../../config/env');

const router = express.Router();

const upload = multer({
    storage: multer.diskStorage({
        destination(req, file, cb) {
            ensureTempUploadDir()
                .then((tempDir) => cb(null, tempDir))
                .catch((error) => cb(error));
        },
        filename(req, file, cb) {
            const timestamp = Date.now();
            const randomSuffix = Math.random().toString(16).slice(2, 10);
            cb(null, `${timestamp}_${randomSuffix}_${sanitizeFilename(file.originalname || 'upload.pdf')}`);
        },
    }),
    limits: {
        fileSize: env.maxUploadFileSizeBytes,
    },
});

router.use(requireAuth);

router.get('/', strictReadLimiter, asyncHandler(getAllSessions));
router.post('/', writeLimiter, validateSchema(createSessionBodySchema), asyncHandler(createNewSession));
router.get('/search', strictReadLimiter, validateSchema(sessionSearchQuerySchema, 'query'), asyncHandler(searchSessions));
router.patch('/:sessionId', writeLimiter, validateSchema(renameSessionBodySchema), asyncHandler(renameExistingSession));
router.get('/:sessionId/meta', strictReadLimiter, asyncHandler(getMetadata));
router.get('/:sessionId', strictReadLimiter, asyncHandler(getSession));
router.delete('/:sessionId', writeLimiter, asyncHandler(deleteSessionHandler));

// Nested PDF routes for a specific session
router.post('/:sessionId/pdfs', uploadLimiter, upload.single('file'), asyncHandler(uploadPdf));
router.get('/:sessionId/pdfs', strictReadLimiter, asyncHandler(getSessionPdfs));

// Nested Chat routes for a specific session
router.post('/:sessionId/chat', chatLimiter, validateSchema(chatBodySchema), asyncHandler(postChat));
router.get('/:sessionId/history', strictReadLimiter, validateSchema(historyQuerySchema, 'query'), asyncHandler(getChatHistory));
router.delete('/:sessionId/history', writeLimiter, asyncHandler(emptyChatHistory));

module.exports = router;
