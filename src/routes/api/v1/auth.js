const express = require('express');
const {
    register,
    sendOtp,
    verifyOtpHandler,
    login,
    refresh,
    requestReset,
    resetPassword,
    me,
    changeEmailRequest,
    performEmailChange,
    listSessions,
    deleteSessionById,
    logout
} = require('../../../controllers/authController');
const {
    registerBodySchema,
    otpBodySchema,
    verifyOtpBodySchema,
    loginBodySchema,
    refreshBodySchema,
    requestResetBodySchema,
    resetPasswordBodySchema,
    changeEmailRequestSchema,
    performEmailChangeSchema
} = require('../../../validations/authSchemas');
const validateSchema = require('../../../middleware/validate');
const requireAuth = require('../../../middleware/requireAuth');
const asyncHandler = require('../../../utils/asyncHandler');
const { registerLimiter, loginLimiter, writeLimiter, strictReadLimiter } = require('../../../middleware/limiters');

const router = express.Router();

// Public Auth routes
router.post('/register', registerLimiter, validateSchema(registerBodySchema), asyncHandler(register));
router.post('/send-otp', registerLimiter, validateSchema(otpBodySchema), asyncHandler(sendOtp));
router.post('/verify-otp', registerLimiter, validateSchema(verifyOtpBodySchema), asyncHandler(verifyOtpHandler));
router.post('/login', loginLimiter, validateSchema(loginBodySchema), asyncHandler(login));
router.post('/refresh', loginLimiter, validateSchema(refreshBodySchema), asyncHandler(refresh));
router.post('/request-reset', registerLimiter, validateSchema(requestResetBodySchema), asyncHandler(requestReset));
router.post('/reset-password', registerLimiter, validateSchema(resetPasswordBodySchema), asyncHandler(resetPassword));

// Protected Auth routes
router.use(requireAuth);

router.get('/me', strictReadLimiter, asyncHandler(me));
router.post('/change-email', writeLimiter, validateSchema(changeEmailRequestSchema), asyncHandler(changeEmailRequest));
router.post('/change-email/verify', writeLimiter, validateSchema(performEmailChangeSchema), asyncHandler(performEmailChange));
router.get('/sessions', strictReadLimiter, asyncHandler(listSessions));
router.delete('/sessions/:sessionId', writeLimiter, asyncHandler(deleteSessionById));
router.delete('/session', writeLimiter, asyncHandler(logout));

module.exports = router;
