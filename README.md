# Document Analyzer RAG Backend

Production-focused Node.js backend for document Q&A with retrieval-augmented generation (RAG).

It supports secure multi-format document ingestion (`pdf`, `docx`, `csv`, `md`, `txt`), local ONNX embeddings (`@xenova/transformers`), SQLite vector retrieval (`better-sqlite3`), JWT auth, background indexing jobs, and SSE chat streaming.

Gemini is used only for chat generation. Embeddings and retrieval are local.

## Architecture

The codebase follows a modular backend layout:

```text
src/
 ├── app.js
 ├── server.js
 ├── config/
 ├── routes/api/v1/
 ├── controllers/
 ├── services/
 ├── middleware/
 ├── parsers/
 ├── utils/
 ├── jobs/
 └── database/
```

Detailed docs:
- `docs/architecture.md`
- `docs/api_reference.md`
- `docs/rag_pipeline.md`
- `docs/system_limits.md`
- `docs/deployment.md`

## RAG Pipeline

1. Upload document to `/api/v1/sessions/:sessionId/pdfs`.
2. Server validates extension + MIME + magic bytes.
3. Background job parses and chunks extracted text.
4. Local embedding model generates vectors.
5. Vectors are stored in SQLite `chunks` table.
6. Chat request retrieves bounded top candidates by cosine similarity.
7. Prompt is built from context + history and sent to Gemini.
8. Response is returned sync/async, with SSE streaming support.

## Installation

```bash
npm install
cp .env.example .env
npm run migrate
npm run dev
```

Server starts at `http://HOST:PORT` (defaults: `0.0.0.0:4000`).

## Environment Variables

See `.env.example` for all variables.

Core runtime variables:
- `PORT`, `HOST`, `NODE_ENV`, `DB_PATH`
- `MAX_UPLOAD_FILE_SIZE_BYTES`, `MAX_DOCS_PER_SESSION`, `MAX_PDF_PAGES`
- `MAX_CHUNKS_PER_QUERY`, `MAX_EXTRACTED_TEXT_LENGTH`
- `GEMINI_API_KEY`, `GEMINI_MODEL`
- `JWT_SECRET`

## System Limits

Default production limits:
- Max upload file size: `30MB`
- Max documents per session: `5`
- Max PDF pages: `150`
- Max chunks scanned per query: `2000`
- Max extracted text length: `2,000,000` chars

## Development Workflow

Commands:

```bash
npm run dev
npm run start
npm run migrate
npm run migrate:dry-run
npm run test
```

Notes:
- Tests run with `NODE_ENV=test`.
- Rate limit middleware is bypassed in tests.
- No external Gemini calls are required for local indexing logic.

## Deployment

1. Set production `.env` values (especially `JWT_SECRET`, `GEMINI_API_KEY`, SMTP creds).
2. Run migrations: `npm run migrate`.
3. Start process: `npm run start`.
4. Put behind reverse proxy (Nginx/Caddy/Cloudflare Tunnel).
5. Enable `TRUST_PROXY=true` when behind proxy.
6. For SSE, disable proxy buffering on chat stream endpoints.

See `docs/deployment.md` for full checklist.

## Security Highlights

- JWT-protected API routes
- Standardized structured error responses
- Prepared statements for SQL operations
- Upload hardening (extension + MIME + signature checks)
- Path safety checks for file storage
- Request body size limits
- Per-session document limits

## License

ISC
