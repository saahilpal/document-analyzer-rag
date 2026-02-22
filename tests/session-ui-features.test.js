const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/database');
const rateLimiter = require('../src/middleware/rateLimiter');
const { addMessage } = require('../src/services/chatHistoryService');
const { addChunks } = require('../src/services/vectorService');
const { createAuthContext } = require('./helpers');

const { __resetRateLimiterStoreForTests } = rateLimiter;

const insertJobStmt = db.prepare(`
  INSERT INTO job_queue (id, type, payload, status, progress, stage, attempts, maxRetries, result, error, createdAt, updatedAt)
  VALUES (@id, @type, @payload, @status, @progress, @stage, @attempts, @maxRetries, @result, @error, @createdAt, @updatedAt)
`);

function uniqueId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

async function createSession(authHeader, titlePrefix = 'Session UI') {
  const response = await request(app)
    .post('/api/v1/sessions')
    .set(authHeader)
    .send({ title: `${titlePrefix} ${Date.now()}` });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  return response.body.data.id;
}

test.beforeEach(() => {
  if (typeof __resetRateLimiterStoreForTests === 'function') {
    __resetRateLimiterStoreForTests();
  }
});

test('auth/me returns correct user', async () => {
  const auth = await createAuthContext(app);

  const response = await request(app)
    .get('/api/v1/auth/me')
    .set(auth.authHeader);

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.data.id, auth.user.id);
  assert.equal(response.body.data.name, auth.user.name);
  assert.equal(response.body.data.email, auth.user.email);
  assert.equal(response.body.data.created_at, auth.user.createdAt);
  assert.equal(Object.hasOwn(response.body.data, 'passwordHash'), false);
  assert.equal(Object.hasOwn(response.body.data, 'password_hash'), false);
});

test('rename session works', async () => {
  const auth = await createAuthContext(app);
  const sessionId = await createSession(auth.authHeader, 'Rename Session');

  const before = await request(app)
    .get(`/api/v1/sessions/${sessionId}`)
    .set(auth.authHeader);

  assert.equal(before.status, 200);
  assert.equal(before.body.ok, true);

  const rename = await request(app)
    .patch(`/api/v1/sessions/${sessionId}`)
    .set(auth.authHeader)
    .send({ title: '   Renamed Project Chat   ' });

  assert.equal(rename.status, 200);
  assert.equal(rename.body.ok, true);
  assert.equal(rename.body.data.id, sessionId);
  assert.equal(rename.body.data.title, 'Renamed Project Chat');
  assert.equal(typeof rename.body.data.updatedAt, 'string');

  const after = await request(app)
    .get(`/api/v1/sessions/${sessionId}`)
    .set(auth.authHeader);

  assert.equal(after.status, 200);
  assert.equal(after.body.ok, true);
  assert.equal(after.body.data.title, 'Renamed Project Chat');
});

test('rename rejects empty title', async () => {
  const auth = await createAuthContext(app);
  const sessionId = await createSession(auth.authHeader, 'Rename Reject');

  const rename = await request(app)
    .patch(`/api/v1/sessions/${sessionId}`)
    .set(auth.authHeader)
    .send({ title: '     ' });

  assert.equal(rename.status, 422);
  assert.equal(rename.body.ok, false);
  assert.equal(rename.body.error.code, 'VALIDATION_ERROR');
});

test('search returns matches', async () => {
  const auth = await createAuthContext(app);
  const otherAuth = await createAuthContext(app);

  await createSession(auth.authHeader, 'Finance Forecast');
  await createSession(auth.authHeader, 'Engineering Notes');
  await createSession(auth.authHeader, 'FINANCE backlog');
  await createSession(otherAuth.authHeader, 'finance private session');

  const search = await request(app)
    .get('/api/v1/sessions/search')
    .set(auth.authHeader)
    .query({ q: 'finance' });

  assert.equal(search.status, 200);
  assert.equal(search.body.ok, true);
  assert.ok(Array.isArray(search.body.data));
  assert.equal(search.body.data.length, 2);

  const titles = search.body.data.map((row) => row.title.toLowerCase());
  assert.ok(titles.some((title) => title.startsWith('finance forecast')));
  assert.ok(titles.some((title) => title.startsWith('finance backlog')));
  assert.equal(titles.some((title) => title.startsWith('finance private session')), false);
});

test('search empty returns []', async () => {
  const auth = await createAuthContext(app);
  await createSession(auth.authHeader, 'Any Session');

  const search = await request(app)
    .get('/api/v1/sessions/search')
    .set(auth.authHeader)
    .query({ q: '   ' });

  assert.equal(search.status, 200);
  assert.equal(search.body.ok, true);
  assert.deepEqual(search.body.data, []);
});

test('meta endpoint returns correct counts', async () => {
  const auth = await createAuthContext(app);
  const sessionId = await createSession(auth.authHeader, 'Meta Session');

  const upload = await request(app)
    .post(`/api/v1/sessions/${sessionId}/pdfs`)
    .set(auth.authHeader)
    .attach('file', Buffer.from('alpha beta gamma', 'utf8'), {
      filename: 'meta.txt',
      contentType: 'text/plain',
    });

  assert.equal(upload.status, 202);
  assert.equal(upload.body.ok, true);

  addMessage({
    userId: auth.user.id,
    sessionId,
    role: 'user',
    text: 'Message one',
  });
  addMessage({
    userId: auth.user.id,
    sessionId,
    role: 'assistant',
    text: 'Message two',
  });

  const meta = await request(app)
    .get(`/api/v1/sessions/${sessionId}/meta`)
    .set(auth.authHeader);

  assert.equal(meta.status, 200);
  assert.equal(meta.body.ok, true);
  assert.equal(meta.body.data.id, sessionId);
  assert.equal(meta.body.data.pdfCount, 1);
  assert.equal(meta.body.data.messageCount, 2);
  assert.equal(typeof meta.body.data.created_at, 'string');
  assert.equal(typeof meta.body.data.updated_at, 'string');
});

test('delete session removes db data, jobs and files', async () => {
  const auth = await createAuthContext(app);
  const sessionId = await createSession(auth.authHeader, 'Delete Session');

  const upload = await request(app)
    .post(`/api/v1/sessions/${sessionId}/pdfs`)
    .set(auth.authHeader)
    .attach('file', Buffer.from('deletion payload', 'utf8'), {
      filename: 'delete-target.txt',
      contentType: 'text/plain',
    });

  assert.equal(upload.status, 202);
  const pdfId = upload.body.data.pdfId;

  const pdfInfo = await request(app)
    .get(`/api/v1/pdfs/${pdfId}`)
    .set(auth.authHeader);

  assert.equal(pdfInfo.status, 200);
  const storagePath = pdfInfo.body.data.path;

  addChunks({
    sessionId,
    pdfId,
    items: [{ text: 'chunk for delete test', embedding: [0.12, 0.33], chunkKey: 'delete-test-chunk' }],
    replacePdfChunks: false,
  });

  addMessage({
    userId: auth.user.id,
    sessionId,
    role: 'user',
    text: 'Delete me',
  });

  const now = new Date().toISOString();
  insertJobStmt.run({
    id: uniqueId('job_chat'),
    type: 'chatQuery',
    payload: JSON.stringify({ userId: auth.user.id, sessionId, message: 'queued message' }),
    status: 'queued',
    progress: 0,
    stage: 'retrieving',
    attempts: 0,
    maxRetries: 1,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  });
  insertJobStmt.run({
    id: uniqueId('job_index'),
    type: 'indexPdf',
    payload: JSON.stringify({ userId: auth.user.id, pdfId }),
    status: 'queued',
    progress: 0,
    stage: 'parsing',
    attempts: 0,
    maxRetries: 1,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  });

  const remove = await request(app)
    .delete(`/api/v1/sessions/${sessionId}`)
    .set(auth.authHeader);

  assert.equal(remove.status, 200);
  assert.equal(remove.body.ok, true);
  assert.equal(remove.body.data.deleted, true);
  assert.equal(remove.body.data.id, sessionId);

  const sessionCount = db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, auth.user.id).count;
  const pdfCount = db.prepare('SELECT COUNT(*) AS count FROM pdfs WHERE sessionId = ? AND user_id = ?').get(sessionId, auth.user.id).count;
  const chunkCount = db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE sessionId = ?').get(sessionId).count;
  const messageCount = db.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE sessionId = ? AND user_id = ?').get(sessionId, auth.user.id).count;
  const jobCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM job_queue j
    WHERE CAST(json_extract(j.payload, '$.userId') AS INTEGER) = @userId
      AND (
        CAST(json_extract(j.payload, '$.sessionId') AS INTEGER) = @sessionId
        OR CAST(json_extract(j.payload, '$.pdfId') AS INTEGER) = @pdfId
      )
  `).get({ userId: auth.user.id, sessionId, pdfId }).count;

  assert.equal(sessionCount, 0);
  assert.equal(pdfCount, 0);
  assert.equal(chunkCount, 0);
  assert.equal(messageCount, 0);
  assert.equal(jobCount, 0);

  const deletedPdf = await request(app)
    .get(`/api/v1/pdfs/${pdfId}`)
    .set(auth.authHeader);
  assert.equal(deletedPdf.status, 400);

  await fs.stat(storagePath)
    .then(() => {
      assert.fail('Expected uploaded file to be deleted from disk.');
    })
    .catch((error) => {
      assert.equal(error.code, 'ENOENT');
    });
});
