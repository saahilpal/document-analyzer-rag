const { requestOTP, verifyOTP, activateUser, authenticateUser, createJWTAuthSession, toPublicUser, createUser, rotateRefreshToken, requestPasswordReset, executePasswordReset, updateUserEmail, deleteAuthSessionById } = require('../services/authService');
const { sendEmail } = require('../services/emailService');
const { getClientMetadata } = require('../utils/helpers');
const { createHttpError } = require('../utils/errors');
const { logError } = require('../config/logger');
const env = require('../config/env');
const { ok, fail } = require('../routes/helpers');
const db = require('../config/database');

async function register(req, res) {
    const user = await createUser({
        name: req.body.name,
        email: req.body.email,
        password: req.body.password,
    });

    let otp;
    if (!user.isActive) {
        try {
            otp = await requestOTP(user.email, 'register');
        } catch (err) {
            logError('ERROR_EMAIL', err, { route: '/auth/register' });
        }
    }

    const response = { message: 'If account exists, email sent.' };
    if (env.nodeEnv === 'test' && otp) {
        response.otp = otp;
    }
    return ok(res, response);
}

async function sendOtp(req, res) {
    let otp;
    try {
        otp = await requestOTP(req.body.email, 'register');
    } catch (err) {
        logError('ERROR_EMAIL', err, { route: '/auth/send-otp' });
    }
    const response = { message: 'If account exists, email sent.' };
    if (env.nodeEnv === 'test' && otp) {
        response.otp = otp;
    }
    return ok(res, response);
}

async function verifyOtpHandler(req, res) {
    await verifyOTP(req.body.email, 'register', req.body.otp);
    activateUser(req.body.email);
    try {
        await sendEmail('welcome', { to: req.body.email });
    } catch (err) {
        logError('ERROR_EMAIL', err, { route: '/auth/verify-otp' });
    }
    return ok(res, { message: 'Account verified successfully.' });
}

async function login(req, res) {
    const user = await authenticateUser({
        email: req.body.email,
        password: req.body.password,
        ipAddress: req.ip,
    });

    if (!user.isActive) {
        return fail(res, createHttpError(403, 'INACTIVE_ACCOUNT', 'Please verify your email address to log in.'), 403);
    }

    const { deviceInfo, ipAddress } = getClientMetadata(req);

    const authSession = createJWTAuthSession({
        userId: user.id,
        deviceInfo,
        ipAddress,
    });

    try {
        await sendEmail('alert', { to: user.email, ip: ipAddress, device: deviceInfo });
    } catch (err) {
        logError('ERROR_EMAIL', err, { route: '/auth/login' });
    }

    return ok(res, {
        accessToken: authSession.accessToken,
        refreshToken: authSession.refreshToken,
        expiresAt: authSession.expiresAt,
        user: toPublicUser(user),
    });
}

async function refresh(req, res) {
    const { ipAddress } = getClientMetadata(req);
    const session = await rotateRefreshToken(req.body.refreshToken, ipAddress);

    return ok(res, {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresAt: session.expiresAt
    });
}

async function requestReset(req, res) {
    let otp;
    try {
        otp = await requestPasswordReset(req.body.email);
    } catch (err) {
        logError('ERROR_EMAIL', err, { route: '/auth/request-reset' });
    }
    const response = { message: 'If account exists, email sent.' };
    if (env.nodeEnv === 'test' && otp) {
        response.otp = otp;
    }
    return ok(res, response);
}

async function resetPassword(req, res) {
    await executePasswordReset(req.body.email, req.body.otp, req.body.newPassword);
    return ok(res, { message: 'Password reset successfully. Please log in with your new password.' });
}

async function me(req, res) {
    return ok(res, {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        created_at: req.user.createdAt,
        is_active: req.user.isActive
    });
}

async function changeEmailRequest(req, res) {
    let otp;
    try {
        otp = await requestOTP(req.body.newEmail, 'change_email');
    } catch (err) {
        logError('ERROR_EMAIL', err, { route: '/auth/change-email' });
    }
    return ok(res, { message: 'If account exists, email sent.', otp });
}

async function performEmailChange(req, res) {
    await verifyOTP(req.body.newEmail, 'change_email', req.body.otp);
    updateUserEmail(req.user.id, req.body.newEmail);
    return ok(res, { message: 'Email updated successfully.' });
}

async function listSessions(req, res) {
    const sessions = db.prepare(`SELECT id, device_info, ip_address, created_at, last_used_at FROM auth_sessions WHERE user_id = ? ORDER BY last_used_at DESC`).all(req.user.id);
    return ok(res, { sessions });
}

async function deleteSessionById(req, res) {
    const { sessionId } = req.params;

    // We ensure they can only delete their own sessions
    const session = db.prepare(`SELECT id FROM auth_sessions WHERE id = ? AND user_id = ?`).get(sessionId, req.user.id);
    if (!session) {
        throw createHttpError(404, 'NOT_FOUND', 'Session not found.');
    }

    deleteAuthSessionById(session.id);
    return ok(res, { deleted: true });
}

function logout(req, res) {
    deleteAuthSessionById(req.authSession.id);
    return ok(res, { loggedOut: true });
}

module.exports = {
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
};
