const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { Document, HeadingLevel, Packer, Paragraph, TextRun } = require('docx');
const app = require('../src/app');
const { __resetRateLimiterStoreForTests } = require('../src/middleware/rateLimiter');
const { createAuthContext, waitForPdfStatus } = require('./helpers');
const { MAX_UPLOAD_FILE_SIZE_BYTES } = require('../src/services/uploadService');

test.beforeEach(() => {
  if (typeof __resetRateLimiterStoreForTests === 'function') {
    __resetRateLimiterStoreForTests();
  }
});

async function createSession(authHeader, titlePrefix = 'Multi Format') {
  const response = await request(app)
    .post('/api/v1/sessions')
    .set(authHeader)
    .send({ title: `${titlePrefix} ${Date.now()}` });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  return response.body.data.id;
}

async function buildDocxBuffer() {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun('Quarterly Analysis')],
        }),
        new Paragraph({ text: 'Revenue is improving quarter over quarter.' }),
        new Paragraph({ text: 'Risks include supplier delays and volatility.' }),
      ],
    }],
  });

  return Packer.toBuffer(doc);
}

test('upload txt -> indexed', async () => {
  const auth = await createAuthContext(app);
  const sessionId = await createSession(auth.authHeader, 'TXT Upload');

  const upload = await request(app)
    .post(`/api/v1/sessions/${sessionId}/pdfs`)
    .set(auth.authHeader)
    .attach('file', Buffer.from('alpha beta\ngamma delta', 'utf8'), {
      filename: 'notes.txt',
      contentType: 'text/plain',
    });

  assert.equal(upload.status, 202);
  assert.equal(upload.body.ok, true);

  const indexed = await waitForPdfStatus(app, upload.body.data.pdfId, 'indexed', 30_000, auth.authHeader);
  assert.equal(indexed.type, 'txt');
  assert.match(indexed.filename, /\.txt$/i);
});

test('upload md -> indexed', async () => {
  const auth = await createAuthContext(app);
  const sessionId = await createSession(auth.authHeader, 'MD Upload');

  const markdown = [
    '# Title',
    '',
    'A paragraph with [a link](https://example.com).',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '- bullet item',
  ].join('\n');

  const upload = await request(app)
    .post(`/api/v1/sessions/${sessionId}/pdfs`)
    .set(auth.authHeader)
    .attach('file', Buffer.from(markdown, 'utf8'), {
      filename: 'readme.md',
      contentType: 'text/markdown',
    });

  assert.equal(upload.status, 202);
  assert.equal(upload.body.ok, true);

  const indexed = await waitForPdfStatus(app, upload.body.data.pdfId, 'indexed', 30_000, auth.authHeader);
  assert.equal(indexed.type, 'md');
  assert.match(indexed.filename, /\.md$/i);
});

test('upload docx -> indexed', async () => {
  const auth = await createAuthContext(app);
  const sessionId = await createSession(auth.authHeader, 'DOCX Upload');

  const upload = await request(app)
    .post(`/api/v1/sessions/${sessionId}/pdfs`)
    .set(auth.authHeader)
    .attach('file', await buildDocxBuffer(), {
      filename: 'report.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

  assert.equal(upload.status, 202);
  assert.equal(upload.body.ok, true);

  const indexed = await waitForPdfStatus(app, upload.body.data.pdfId, 'indexed', 30_000, auth.authHeader);
  assert.equal(indexed.type, 'docx');
  assert.match(indexed.filename, /\.docx$/i);
});

test('upload csv -> indexed', async () => {
  const auth = await createAuthContext(app);
  const sessionId = await createSession(auth.authHeader, 'CSV Upload');

  const csv = ['name,age,team', 'john,20,alpha', 'maria,31,beta'].join('\n');

  const upload = await request(app)
    .post(`/api/v1/sessions/${sessionId}/pdfs`)
    .set(auth.authHeader)
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'people.csv',
      contentType: 'text/csv',
    });

  assert.equal(upload.status, 202);
  assert.equal(upload.body.ok, true);

  const indexed = await waitForPdfStatus(app, upload.body.data.pdfId, 'indexed', 30_000, auth.authHeader);
  assert.equal(indexed.type, 'csv');
  assert.match(indexed.filename, /\.csv$/i);
});

test('invalid mime -> rejected', async () => {
  const auth = await createAuthContext(app);
  const sessionId = await createSession(auth.authHeader, 'Invalid MIME');

  const upload = await request(app)
    .post(`/api/v1/sessions/${sessionId}/pdfs`)
    .set(auth.authHeader)
    .attach('file', Buffer.from('MZ.....', 'utf8'), {
      filename: 'malware.exe',
      contentType: 'application/octet-stream',
    });

  assert.equal(upload.status, 415);
  assert.equal(upload.body.ok, false);
  assert.equal(upload.body.error.code, 'INVALID_FILE_MIME');
});

test('corrupted file -> error', async () => {
  const auth = await createAuthContext(app);
  const sessionId = await createSession(auth.authHeader, 'Corrupted DOCX');

  // Valid ZIP header, invalid DOCX payload.
  const corruptedDocx = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00]);

  const upload = await request(app)
    .post(`/api/v1/sessions/${sessionId}/pdfs`)
    .set(auth.authHeader)
    .attach('file', corruptedDocx, {
      filename: 'broken.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

  assert.equal(upload.status, 202);
  assert.equal(upload.body.ok, true);

  const failed = await waitForPdfStatus(app, upload.body.data.pdfId, 'failed', 30_000, auth.authHeader);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.type, 'docx');
});

test('huge file -> rejected', async () => {
  const auth = await createAuthContext(app);
  const sessionId = await createSession(auth.authHeader, 'Huge Upload');

  const tooLarge = Buffer.alloc(MAX_UPLOAD_FILE_SIZE_BYTES + 1, 0x61);

  const upload = await request(app)
    .post(`/api/v1/sessions/${sessionId}/pdfs`)
    .set(auth.authHeader)
    .attach('file', tooLarge, {
      filename: 'huge.txt',
      contentType: 'text/plain',
    });

  assert.equal(upload.status, 400);
  assert.equal(upload.body.ok, false);
  assert.equal(upload.body.error.code, 'UPLOAD_TOO_LARGE');
});
