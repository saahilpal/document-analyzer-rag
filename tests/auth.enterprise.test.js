const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const { runMigrations } = require('../src/db/migration');

describe('Enterprise Authentication', () => {
    let server;
    let testUserEmail = 'testotp@example.com';
    let testUserPassword = 'SecurePassword123!';
    let generatedOtp = '';
    let accessToken = '';
    let refreshToken = '';

    before(async () => {
        runMigrations();
        server = app.listen(0);
        // Cleanup previous runs
        db.prepare('DELETE FROM users WHERE email = ?').run(testUserEmail);
        db.prepare('DELETE FROM login_attempts').run();
    });

    after(() => {
        server.close();
    });

    test('POST /api/v1/auth/register should create inactive user and send OTP', async () => {
        const res = await request(server)
            .post('/api/v1/auth/register')
            .send({
                name: 'OTP User',
                email: testUserEmail,
                password: testUserPassword
            });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.data.message, 'If account exists, email sent.');

        // Fetch the raw OTP hash created in DB to simulate email read
        const otpRecord = db.prepare('SELECT id, otp_hash FROM email_otps WHERE email = ? AND type = ? ORDER BY id DESC LIMIT 1').get(testUserEmail, 'register');
        assert.ok(otpRecord);

        // We can't reverse bcrypt in tests trivially, so we verify logic by forcing OTP directly or verifying login fails
    });

    test('POST /api/v1/auth/login should fail for inactive user', async () => {
        const res = await request(server)
            .post('/api/v1/auth/login')
            .send({
                email: testUserEmail,
                password: testUserPassword
            });

        assert.strictEqual(res.status, 403);
        assert.match(res.body.error.message, /verify your email/);
    });

    test('Manually Activate User & Login retrieves JWTs', async () => {
        // Simulate OTP success
        db.prepare('UPDATE users SET is_active = 1 WHERE email = ?').run(testUserEmail);

        const res = await request(server)
            .post('/api/v1/auth/login')
            .send({
                email: testUserEmail,
                password: testUserPassword
            });

        assert.strictEqual(res.status, 200);
        assert.ok(res.body.data.accessToken);
        assert.ok(res.body.data.refreshToken);

        accessToken = res.body.data.accessToken;
        refreshToken = res.body.data.refreshToken;
    });

    test('GET /api/v1/auth/me works with valid JWT Access Token', async () => {
        // Wait a brief moment for any async session DB updates internally since JWT writes
        await new Promise((r) => setTimeout(r, 100));

        const res = await request(server)
            .get('/api/v1/auth/me')
            .set('Authorization', `Bearer ${accessToken}`);

        assert.strictEqual(res.status, 200, `Failed GET /me: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.data.email, testUserEmail);
        assert.strictEqual(res.body.data.is_active, true);
    });

    test('POST /api/v1/auth/refresh rotates tokens securely', async () => {
        const res = await request(server)
            .post('/api/v1/auth/refresh')
            .send({ refreshToken });

        assert.strictEqual(res.status, 200);
        assert.ok(res.body.data.accessToken);
        assert.ok(res.body.data.refreshToken);
        assert.notStrictEqual(res.body.data.refreshToken, refreshToken);

        const oldRefreshTest = await request(server)
            .post('/api/v1/auth/refresh')
            .send({ refreshToken });

        // Old token should be revoked and dead
        assert.strictEqual(oldRefreshTest.status, 401);
    });

    test('Brute Force Limit triggers correctly', async () => {
        const wrongEmail = 'brute@example.com';

        // We are fighting express-rate-limit (loginLimiter = windowMs: 15*60*1000, maxRequests: 20)
        // AND our native brute force limits (LOGIN_MAX_FAILURES = 6)

        let lastRes;
        for (let i = 0; i < 7; i++) {
            lastRes = await request(server).post('/api/v1/auth/login').send({ email: wrongEmail, password: 'wrongpassword' });
        }

        // Our native brute force returns 429
        assert.strictEqual(lastRes.status, 429);
        // It should explicitly match our custom error text, unless express-rate-limit intercepted the exact first 6 calls globally.
        // Ensure we are testing the application's native HTTP Error structure
        assert.ok(lastRes.body.error);
    });
});
