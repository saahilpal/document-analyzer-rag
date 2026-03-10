const { z } = require('zod');

const registerBodySchema = z.object({
    name: z.string().min(1).max(120),
    email: z.string().email().max(320),
    password: z.string().min(8).max(128),
});

const loginBodySchema = z.object({
    email: z.string().email().max(320),
    password: z.string().min(8).max(128),
});

const otpBodySchema = z.object({
    email: z.string().email().max(320),
});

const verifyOtpBodySchema = z.object({
    email: z.string().email().max(320),
    otp: z.string().min(6).max(6),
});

const refreshBodySchema = z.object({
    refreshToken: z.string().min(1),
});

const requestResetBodySchema = z.object({
    email: z.string().email().max(320),
});

const resetPasswordBodySchema = z.object({
    email: z.string().email().max(320),
    otp: z.string().min(6).max(6),
    newPassword: z.string().min(8).max(128),
});

const changeEmailRequestSchema = z.object({
    newEmail: z.string().email().max(320),
});

const performEmailChangeSchema = z.object({
    newEmail: z.string().email().max(320),
    otp: z.string().min(6).max(6)
});

module.exports = {
    registerBodySchema,
    loginBodySchema,
    otpBodySchema,
    verifyOtpBodySchema,
    refreshBodySchema,
    requestResetBodySchema,
    resetPasswordBodySchema,
    changeEmailRequestSchema,
    performEmailChangeSchema
};
