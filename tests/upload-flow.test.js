const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const request = require('supertest');
const app = require('../src/app');
const { createAuthContext, buildSamplePdfBuffer } = require('./helpers');

test('upload flow persists PDF and returns processing metadata', async () => {
  const auth = await createAuthContext(app);

  const session = await request(app)
    .post('/api/v1/sessions')
    .set(auth.authHeader)
    .send({ title: `Upload Flow ${Date.now()}` });
  assert.equal(session.status, 200);

  const upload = await request(app)
    .post(`/api/v1/sessions/${session.body.data.id}/pdfs`)
    .set(auth.authHeader)
    .attach('file', await buildSamplePdfBuffer(), { filename: 'upload-flow.pdf', contentType: 'application/pdf' })
    .field('title', 'Upload Flow PDF');

  assert.equal(upload.status, 202);
  assert.equal(upload.body.ok, true);
  assert.equal(upload.body.data.status, 'processing');
  assert.equal(typeof upload.body.data.jobId, 'string');
  assert.equal(typeof upload.body.data.progress, 'number');
  assert.equal(typeof upload.body.data.stage, 'string');

  const pdfInfo = await request(app)
    .get(`/api/v1/pdfs/${upload.body.data.pdfId}`)
    .set(auth.authHeader);
  assert.equal(pdfInfo.status, 200);
  const storagePath = pdfInfo.body.data.path;
  assert.equal(typeof storagePath, 'string');

  const stat = await fs.stat(storagePath);
  assert.ok(stat.isFile());
});
