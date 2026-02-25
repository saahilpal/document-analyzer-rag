const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const { runMigrations } = require('../src/db/migration');

describe('Password Reset OTP Flow', () => {
    let server;
    const testUserEmail = 'resetotp@example.com';
    const testUserPassword = 'InitialPassword123!';
    const newPassword = 'NewPassword456!';

    before(async () => {
        runMigrations();
        server = app.listen(0);
        db.prepare('DELETE FROM users WHERE email = ?').run(testUserEmail);
        db.prepare('DELETE FROM login_attempts').run();
        db.prepare('DELETE FROM password_reset_otps').run();

        // Register and activate a test user
        await request(server)
            .post('/api/v1/auth/register')
            .send({
                name: 'Reset OTP User',
                email: testUserEmail,
                password: testUserPassword
            });
        db.prepare('UPDATE users SET is_active = 1 WHERE email = ?').run(testUserEmail);
    });

    after(() => {
        server.close();
    });

    test('POST /api/v1/auth/request-reset should generate 6-digit OTP', async () => {
        const res = await request(server)
            .post('/api/v1/auth/request-reset')
            .send({ email: testUserEmail });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.data.message, 'If account exists, email sent.');

        const otpRecord = db.prepare('SELECT * FROM password_reset_otps WHERE user_id = (SELECT id FROM users WHERE email = ?) ORDER BY id DESC LIMIT 1').get(testUserEmail);
        assert.ok(otpRecord);
        assert.strictEqual(otpRecord.attempts, 0);
        assert.strictEqual(otpRecord.used, 0);
    });

    // We cannot easily retrieve the real OTP since it's hashed in the DB and emailed.
    // For tests, let's inject a known OTP by generating one and hashing it directly.
    test('POST /api/v1/auth/reset-password with invalid OTP should fail and increment attempts', async () => {
        const res = await request(server)
            .post('/api/v1/auth/reset-password')
            .send({
                email: testUserEmail,
                otp: '000000',
                newPassword
            });

        assert.strictEqual(res.status, 400);

        const otpRecord = db.prepare('SELECT attempts FROM password_reset_otps WHERE user_id = (SELECT id FROM users WHERE email = ?) ORDER BY id DESC LIMIT 1').get(testUserEmail);
        assert.strictEqual(otpRecord.attempts, 1);
    });

    test('POST /api/v1/auth/reset-password should lockout after 3 failed attempts', async () => {
        await request(server).post('/api/v1/auth/reset-password').send({ email: testUserEmail, otp: '000000', newPassword });
        await request(server).post('/api/v1/auth/reset-password').send({ email: testUserEmail, otp: '000000', newPassword });

        const res = await request(server)
            .post('/api/v1/auth/reset-password')
            .send({ email: testUserEmail, otp: '123456', newPassword });

        assert.strictEqual(res.status, 400);
        assert.match(res.body.error.message, /Too many attempts/);
    });

    test('POST /api/v1/auth/reset-password with valid OTP should succeed and mark used', async () => {
        // Request a new reset to get a fresh OTP record
        await request(server)
            .post('/api/v1/auth/request-reset')
            .send({ email: testUserEmail });

        // Generate and inject a known OTP hash
        const crypto = require('crypto');
        const bcrypt = require('bcryptjs');
        const knownOtp = '123456';
        const hash = bcrypt.hashSync(knownOtp, 12);

        db.prepare('UPDATE password_reset_otps SET otp_hash = ? WHERE user_id = (SELECT id FROM users WHERE email = ?) AND used = 0').run(hash, testUserEmail);

        const res = await request(server)
            .post('/api/v1/auth/reset-password')
            .send({
                email: testUserEmail,
                otp: knownOtp,
                newPassword
            });

        assert.strictEqual(res.status, 200, `Failed reset: ${JSON.stringify(res.body)}`);

        const otpRecord = db.prepare('SELECT used FROM password_reset_otps WHERE user_id = (SELECT id FROM users WHERE email = ?) ORDER BY id DESC LIMIT 1').get(testUserEmail);
        assert.strictEqual(otpRecord.used, 1);

        // Login with new password should work
        const loginRes = await request(server)
            .post('/api/v1/auth/login')
            .send({
                email: testUserEmail,
                password: newPassword
            });

        assert.strictEqual(loginRes.status, 200);
    });
});
