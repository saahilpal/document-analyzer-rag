const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');

function buildUserPayload() {
  const unique = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  return {
    name: `Auth User ${unique}`,
    email: `auth_${unique}@example.com`,
    password: 'SecurePass123!',
  };
}

test('auth register/login/logout lifecycle', async () => {
  const userPayload = buildUserPayload();

  const register = await request(app)
    .post('/api/v1/auth/register')
    .send(userPayload);

  assert.equal(register.status, 200);
  assert.equal(register.body.ok, true);
  assert.equal(typeof register.body.data.token, 'string');
  assert.equal(typeof register.body.data.expiresAt, 'string');
  assert.equal(register.body.data.user.email, userPayload.email.toLowerCase());

  const protectedWithToken = await request(app)
    .get('/api/v1/sessions')
    .set('Authorization', `Bearer ${register.body.data.token}`);

  assert.equal(protectedWithToken.status, 200);
  assert.equal(protectedWithToken.body.ok, true);

  const login = await request(app)
    .post('/api/v1/auth/login')
    .send({
      email: userPayload.email,
      password: userPayload.password,
    });

  assert.equal(login.status, 200);
  assert.equal(login.body.ok, true);
  assert.equal(typeof login.body.data.token, 'string');
  assert.notEqual(login.body.data.token, register.body.data.token);

  const logout = await request(app)
    .delete('/api/v1/auth/session')
    .set('Authorization', `Bearer ${login.body.data.token}`);

  assert.equal(logout.status, 200);
  assert.equal(logout.body.ok, true);
  assert.equal(logout.body.data.loggedOut, true);

  const afterLogout = await request(app)
    .get('/api/v1/sessions')
    .set('Authorization', `Bearer ${login.body.data.token}`);

  assert.equal(afterLogout.status, 401);
  assert.equal(afterLogout.body.ok, false);
  assert.equal(afterLogout.body.error.code, 'UNAUTHORIZED');
});

test('login does not enumerate users', async () => {
  const userPayload = buildUserPayload();

  const register = await request(app)
    .post('/api/v1/auth/register')
    .send(userPayload);
  assert.equal(register.status, 200);

  const missingUser = await request(app)
    .post('/api/v1/auth/login')
    .send({
      email: `missing_${Date.now()}@example.com`,
      password: 'SecurePass123!',
    });

  const wrongPassword = await request(app)
    .post('/api/v1/auth/login')
    .send({
      email: userPayload.email,
      password: 'WrongPassword123!',
    });

  assert.equal(missingUser.status, 401);
  assert.equal(wrongPassword.status, 401);
  assert.equal(missingUser.body.ok, false);
  assert.equal(wrongPassword.body.ok, false);
  assert.equal(missingUser.body.error.code, 'INVALID_CREDENTIALS');
  assert.equal(wrongPassword.body.error.code, 'INVALID_CREDENTIALS');
  assert.equal(missingUser.body.error.message, wrongPassword.body.error.message);
});
