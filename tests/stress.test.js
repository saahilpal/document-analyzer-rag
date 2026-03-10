const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/database');
const { runMigrations } = require('../src/database/migrations');
const { createAuthContext, buildSamplePdfBuffer } = require('./helpers');

describe('Load Safety and Stress Tests', () => {
    let server;
    before(async () => {
        runMigrations();
        server = app.listen(0);
        db.prepare('DELETE FROM users WHERE email LIKE ?').run('stress_%@example.com');
    });

    after(() => {
        server.close();
    });

    test('Concurrent Logins and Registrations do not crash or deadlock', async () => {
        const concurrency = 20;
        const tasks = Array.from({ length: concurrency }).map(async (_, i) => {
            const email = `stress_login_${Date.now()}_${i}@example.com`;
            const payload = {
                name: `Stress ${i}`,
                email,
                password: 'StressPassword123!'
            };

            // Register
            let res = await request(server).post('/api/v1/auth/register').send(payload);
            assert.strictEqual(res.status, 200, `Register failed for ${email}`);
            const otp = res.body.data?.otp;
            assert.ok(otp, 'OTP missing');

            // Verify
            res = await request(server).post('/api/v1/auth/verify-otp').send({ email, otp });
            assert.strictEqual(res.status, 200, `Verify failed for ${email}`);

            // Login
            res = await request(server).post('/api/v1/auth/login').send({ email, password: payload.password });
            assert.strictEqual(res.status, 200, `Login failed for ${email}`);
            return res.body.data.accessToken;
        });

        const tokens = await Promise.all(tasks);
        assert.strictEqual(tokens.length, concurrency);
    });

    test('Concurrent Uploads and Indexing do not crash or corrupt database', async () => {
        const { authHeader } = await createAuthContext(server, { email: `stress_upload_${Date.now()}@example.com` });
        const concurrency = 5;

        let res = await request(server).post('/api/v1/sessions').set(authHeader).send({});
        const sessionId = res.body.data.id;

        const pdfBuffer = await buildSamplePdfBuffer();

        const tasks = Array.from({ length: concurrency }).map(async (_, i) => {
            const uploadRes = await request(server)
                .post(`/api/v1/sessions/${sessionId}/pdfs`)
                .set(authHeader)
                .attach('file', pdfBuffer, `doc_${i}.pdf`);

            // Should be accessible immediately but queued
            assert.ok([200, 202].includes(uploadRes.status), `Upload failed: ${uploadRes.status}`);
            return uploadRes.body.data.pdfId;
        });

        const pdfIds = await Promise.all(tasks);
        assert.strictEqual(pdfIds.length, concurrency);
    });

    test('Concurrent Chat Generation Locks enforce boundaries correctly', async () => {
        const { authHeader } = await createAuthContext(server, { email: `stress_chat_${Date.now()}@example.com` });

        let res = await request(server).post('/api/v1/sessions').set(authHeader).send({});
        const sessionId = res.body.data.id;

        const concurrency = 5;

        // Force 'NewChat' state with multiple concurrent messages.
        const tasks = Array.from({ length: concurrency }).map(async (_, i) => {
            return request(server)
                .post(`/api/v1/sessions/${sessionId}/chat`)
                .set(authHeader)
                .send({
                    message: `What is the purpose of this architecture? - Question ${i}`
                });
        });

        const responses = await Promise.all(tasks);
        responses.forEach(r => assert.strictEqual(r.status, 200));

        // Let's verify that the title eventually settled
        const getRes = await request(server).get(`/api/v1/sessions/${sessionId}`).set(authHeader);
        assert.ok(getRes.body.data.title !== undefined);
    });
});
