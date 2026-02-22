const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const { createAuthContext } = require('./helpers');

test('error responses return structured payloads', async () => {
  const auth = await createAuthContext(app);

  const response = await request(app)
    .post('/api/v1/sessions')
    .set(auth.authHeader)
    .send({ title: '' });

  assert.equal(response.status, 422);
  assert.equal(response.body.ok, false);
  assert.equal(typeof response.body.error, 'object');
  assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  assert.equal(typeof response.body.error.message, 'string');
  assert.equal(typeof response.body.error.retryable, 'boolean');
});
