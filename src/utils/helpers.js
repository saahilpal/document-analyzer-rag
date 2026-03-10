const { sanitizeFilename } = require('../services/uploadService');
const { createHttpError } = require('./errors');

function getClientMetadata(req) {
    return {
        deviceInfo: String(req.headers['user-agent'] || '').trim() || null,
        ipAddress: String(req.ip || '').trim() || null,
    };
}

function parsePositiveInt(value, fieldName) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw createHttpError(400, 'INVALID_PATH_PARAM', `${fieldName} must be a positive integer.`, {
            retryable: false,
        });
    }
    return parsed;
}

function normalizeOptionalTitle(title, fallback) {
    const normalized = String(title || '').trim();
    if (normalized) {
        return normalized;
    }
    return sanitizeFilename(fallback || 'uploaded').replace(/\.[a-z0-9]{1,12}$/i, '');
}

function validateHistory(history) {
    if (!Array.isArray(history)) {
        return [];
    }

    return history
        .filter((entry) => entry && (entry.role === 'user' || entry.role === 'assistant') && typeof entry.text === 'string')
        .map((entry) => ({ role: entry.role, text: entry.text.trim() }))
        .filter((entry) => entry.text.length > 0);
}

module.exports = {
    getClientMetadata,
    parsePositiveInt,
    normalizeOptionalTitle,
    validateHistory,
};
