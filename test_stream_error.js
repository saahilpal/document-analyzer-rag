const http = require('http');
const request = require('supertest');
const app = require('./src/app');
const { createAuthContext, buildSamplePdfBuffer } = require('./tests/helpers');

async function runTest() {
  const auth = await createAuthContext(app);
  const sessionRes = await request(app).post('/api/v1/sessions').set(auth.authHeader).send({ title: 'Stream Error Audit' });
  const sessionId = sessionRes.body.data.id;
  await request(app).post(`/api/v1/sessions/${sessionId}/pdfs`).set(auth.authHeader).attach('file', await buildSamplePdfBuffer(), { filename: 'test.pdf', contentType: 'application/pdf' });
  
  const options = {
    hostname: 'localhost',
    port: process.env.PORT || 4000,
    path: `/api/v1/sessions/${sessionId}/chat?stream=true`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream', 'Authorization': auth.authHeader.Authorization }
  };

  const server = app.listen(options.port, () => {
    const req = http.request(options, (res) => {
      console.log(`STATUS: ${res.statusCode}`);
      console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
      res.setEncoding('utf8');
      res.on('data', (chunk) => console.log('\n--- CHUNK ---', chunk));
      res.on('end', () => { console.log('--- STREAM ENDED ---'); server.close(); });
    });
    req.write(JSON.stringify({ message: 'What is this document about?' }));
    req.end();
  });
}

runTest().catch(console.error);
