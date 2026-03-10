const express = require('express');
const { postChat } = require('../../../controllers/chatController');
const { chatBodySchema } = require('../../../validations/chatSchemas');
const validateSchema = require('../../../middleware/validate');
const requireAuth = require('../../../middleware/requireAuth');
const asyncHandler = require('../../../utils/asyncHandler');
const { createHttpError } = require('../../../utils/errors');
const { fail } = require('../../helpers');
const { chatLimiter } = require('../../../middleware/limiters');

const router = express.Router();

router.use(requireAuth);

router.post('/', chatLimiter, validateSchema(chatBodySchema), asyncHandler(async (req, res) => {
    if (!req.body.sessionId) {
        return fail(res, createHttpError(400, 'INVALID_SESSION_ID', 'sessionId is required in body.'), 400);
    }

    // Forward to the underlying component
    req.params = req.params || {};
    req.params.sessionId = req.body.sessionId;

    return postChat(req, res);
}));

module.exports = router;
