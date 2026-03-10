const request = require('supertest');
const app = require('./src/app');
const db = require('./src/config/database');
const { runMigrations } = require('./src/database/migrations');
const { createAuthContext } = require('./tests/helpers');

async function run() {
  runMigrations();
  const server = app.listen(0);
  const { authHeader } = await createAuthContext(server, { email: `test_${Date.now()}@example.com` });

  const res = await request(server).post('/api/v1/sessions').set(authHeader).send({});
  console.log("STATUS:", res.status);
  console.log("BODY:", JSON.stringify(res.body, null, 2));

  server.close();
}
run();
