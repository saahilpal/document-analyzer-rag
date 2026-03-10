const http = require('http');
const request = require('supertest');
const app = require('./src/app');
const { createAuthContext, buildSamplePdfBuffer, waitForPdfStatus } = require('./tests/helpers');

async function runTest() {
    console.log('Setting up auth context...');
    const auth = await createAuthContext(app);

    console.log('Creating session...');
    const sessionRes = await request(app)
        .post('/api/v1/sessions')
        .set(auth.authHeader)
        .send({ title: 'Stream Audit Session' });
    const sessionId = sessionRes.body.data.id;

    console.log('Uploading PDF...');
    const uploadRes = await request(app)
        .post(`/api/v1/sessions/${sessionId}/pdfs`)
        .set(auth.authHeader)
        .attach('file', await buildSamplePdfBuffer(), { filename: 'test.pdf', contentType: 'application/pdf' });
    const pdfId = uploadRes.body.data.pdfId;

    console.log('Waiting for PDF to index...');
    await waitForPdfStatus(app, pdfId, 'indexed', 30000, auth.authHeader, { forceIndexOnFailure: true });
    console.log('PDF Indexed.');

    console.log('Starting chat stream...');
    const startTime = Date.now();

    // Use http requests manually to stream chunks as they arrive instead of waiting for full response like supertest does
    const options = {
        hostname: 'localhost',
        port: process.env.PORT || 4000,
        path: `/api/v1/chat?stream=true`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'Authorization': auth.authHeader.Authorization
        }
    };

    const server = app.listen(options.port, () => {
        const req = http.request(options, (res) => {
            console.log(`STATUS: ${res.statusCode}`);
            console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
            res.setEncoding('utf8');

            let chunkCount = 0;
            res.on('data', (chunk) => {
                chunkCount++;
                console.log(`\n--- CHUNK ${chunkCount} ---`);
                console.log(chunk);
            });
            res.on('end', () => {
                console.log('\n--- STREAM ENDED ---');
                console.log(`Total time: ${Date.now() - startTime}ms`);
                server.close();
            });
        });

        req.on('error', (e) => {
            console.error(`problem with request: ${e.message}`);
            server.close();
        });

        // Write data to request body
        req.write(JSON.stringify({ sessionId, message: 'What is this document about?' }));
        req.end();
    });
}

runTest().catch(console.error);
