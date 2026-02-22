const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const { createSession } = require('../src/services/sessionService');
const { addMessage } = require('../src/services/chatHistoryService');
const { createAuthContext } = require('./helpers');

test('GET /api/v1/sessions returns metadata sorted by lastMessageAt desc', async () => {
  const auth = await createAuthContext(app);
  const first = createSession(auth.user.id, `Sort A ${Date.now()}`);
  const second = createSession(auth.user.id, `Sort B ${Date.now()}`);
  const third = createSession(auth.user.id, `Sort C ${Date.now()}`);

  addMessage({
    userId: auth.user.id,
    sessionId: first.id,
    role: 'user',
    text: 'first-old',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  addMessage({
    userId: auth.user.id,
    sessionId: third.id,
    role: 'assistant',
    text: 'third-newer',
    createdAt: '2026-01-02T00:00:00.000Z',
  });

  const response = await request(app)
    .get('/api/v1/sessions')
    .set(auth.authHeader);

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.ok(Array.isArray(response.body.data));

  const scoped = response.body.data.filter((session) => [first.id, second.id, third.id].includes(session.id));
  assert.equal(scoped.length, 3);

  assert.equal(scoped[0].id, third.id);
  assert.equal(scoped[1].id, first.id);
  assert.equal(scoped[2].id, second.id);

  scoped.forEach((session) => {
    assert.equal(typeof session.id, 'number');
    assert.equal(typeof session.title, 'string');
    assert.equal(typeof session.lastMessagePreview, 'string');
    assert.equal(typeof session.messageCount, 'number');
    assert.equal(typeof session.pdfCount, 'number');
    assert.ok(Object.hasOwn(session, 'lastMessageAt'));
  });
});

test('GET /api/v1/sessions/:sessionId/history returns chronological messages with createdAt', async () => {
  const auth = await createAuthContext(app);
  const session = createSession(auth.user.id, `History ${Date.now()}`);

  addMessage({
    userId: auth.user.id,
    sessionId: session.id,
    role: 'assistant',
    text: 'Second with **markdown**',
    createdAt: '2026-01-02T00:00:00.000Z',
  });
  addMessage({
    userId: auth.user.id,
    sessionId: session.id,
    role: 'system',
    text: 'First *system*',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  addMessage({
    userId: auth.user.id,
    sessionId: session.id,
    role: 'user',
    text: 'Third final',
    createdAt: '2026-01-03T00:00:00.000Z',
  });

  const response = await request(app)
    .get(`/api/v1/sessions/${session.id}/history`)
    .set(auth.authHeader);

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.ok(Array.isArray(response.body.data));
  assert.equal(response.body.data.length, 3);

  assert.equal(response.body.data[0].text, 'First *system*');
  assert.equal(response.body.data[1].text, 'Second with **markdown**');
  assert.equal(response.body.data[2].text, 'Third final');

  response.body.data.forEach((message) => {
    assert.equal(typeof message.id, 'string');
    assert.ok(['user', 'assistant', 'system'].includes(message.role));
    assert.equal(typeof message.text, 'string');
    assert.ok(Object.hasOwn(message, 'createdAt'));
    assert.ok(typeof message.createdAt === 'string' || typeof message.createdAt === 'number');
  });
});
