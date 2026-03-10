const rateLimiter = require('./rateLimiter');
const env = require('../config/env');

const windowMsMap = {
    register: 15 * 60_000,
    login: 15 * 60_000,
    write: 60_000,
    strictRead: 60_000,
    upload: 60_000,
    chat: 60_000
};

const maxRequestsMap = {
    register: 30,
    login: 20,
    write: 80,
    strictRead: 200,
    upload: 16,
    chat: 30
};

const isTestEnv = env.nodeEnv === 'test';

function createLimiter(type) {
    if (isTestEnv) {
        return (req, res, next) => next();
    }
    return rateLimiter({
        windowMs: windowMsMap[type],
        maxRequests: maxRequestsMap[type],
    });
}

const registerLimiter = createLimiter('register');
const loginLimiter = createLimiter('login');
const writeLimiter = createLimiter('write');
const strictReadLimiter = createLimiter('strictRead');
const uploadLimiter = createLimiter('upload');
const chatLimiter = createLimiter('chat');

module.exports = {
    registerLimiter,
    loginLimiter,
    writeLimiter,
    strictReadLimiter,
    uploadLimiter,
    chatLimiter
};
