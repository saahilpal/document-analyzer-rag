# Document Analyzer RAG Backend

Production-oriented Node.js + Express backend for authenticated, session-based document ingestion and RAG chat.

## Overview
This service provides a local-first Retrieval Augmented Generation (RAG) API with:
- Token-based auth sessions (server-side session store, non-JWT)
- User-isolated sessions, documents, and chat history
- Multi-format document upload and indexing (`.pdf`, `.txt`, `.md`, `.docx`, `.csv`)
- SQLite vector persistence and similarity retrieval
- Sync + async + streaming (SSE) chat responses
- Background job queue with progress tracking

## Response Contract
All endpoints return a consistent envelope:
- Success: `{ ok: true, data: ... }`
- Error: `{ ok: false, error: { code, message, retryable } }`

## Authentication
Auth uses opaque bearer tokens with hashed token storage in `auth_sessions`.

Public routes:
- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `GET /api/v1/health`
- `GET /api/v1/ping`

All other `/api/v1/*` routes require:
- `Authorization: Bearer <token>`

## API Overview
### Auth
- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `GET /api/v1/auth/me`
- `DELETE /api/v1/auth/session`

### Sessions
- `GET /api/v1/sessions`
- `POST /api/v1/sessions`
- `GET /api/v1/sessions/search?q=term`
- `PATCH /api/v1/sessions/:sessionId`
- `GET /api/v1/sessions/:sessionId`
- `GET /api/v1/sessions/:sessionId/meta`
- `DELETE /api/v1/sessions/:sessionId`

### Documents
- `GET /api/v1/sessions/:sessionId/pdfs`
- `POST /api/v1/sessions/:sessionId/pdfs`
- `GET /api/v1/pdfs/:pdfId`
- `DELETE /api/v1/pdfs/:pdfId`

### Chat + History
- `POST /api/v1/sessions/:sessionId/chat`
- `GET /api/v1/sessions/:sessionId/history`
- `DELETE /api/v1/sessions/:sessionId/history`

### Jobs + Ops
- `GET /api/v1/jobs/:jobId`
- `GET /api/v1/admin/queue` (disabled in production)
- `POST /api/v1/admin/reset` (disabled in production)

## Document Ingestion
Supported upload MIME types:
- `application/pdf`
- `text/plain`
- `text/markdown`
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- `text/csv`

Upload flow:
1. Multipart upload to `/sessions/:sessionId/pdfs`
2. MIME + signature + size validation
3. Parser selection by detected file type
4. Text sanitization/normalization
5. Existing chunking/embedding/vector pipeline

## Tech Stack
- Runtime: Node.js (CommonJS)
- Web: Express
- DB: SQLite (`better-sqlite3`)
- Validation: `zod`
- Auth: `bcryptjs`, crypto token hashing
- Upload/parsing: `multer`, `pdf-parse`, `mammoth`
- Embeddings: `@xenova/transformers`
- Generation: `@google/genai` (Gemini)
- Tests: Node test runner, `supertest`, `pdfkit`, `docx`

## Setup
1. Install dependencies:
```bash
npm install
```

2. Create environment file:
```bash
cp .env.example .env
```

3. Set required environment values (at minimum `GEMINI_API_KEY`).

4. Run migrations:
```bash
npm run migrate
```

5. Start server:
```bash
npm run dev
```

## Environment Variables
| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | `development` | Runtime mode |
| `TRUST_PROXY` | `false` | Express proxy trust |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | Allowed origins |
| `GEMINI_API_KEY` | - | Gemini API key |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Comma-separated model candidates |
| `DEFAULT_ADMIN_NAME` | `Default Admin` | Migration bootstrap user name |
| `DEFAULT_ADMIN_EMAIL` | `admin@local` | Migration bootstrap user email |
| `DEFAULT_ADMIN_PASSWORD` | generated if unset/invalid | Migration bootstrap user password |
| `MAX_UPLOAD_FILE_SIZE_BYTES` | `52428800` | Upload max size |
| `AUTH_LOGIN_WINDOW_MS` | `900000` | Login failure rolling window |
| `AUTH_LOGIN_LOCK_MS` | `900000` | Lock duration after max failures |
| `AUTH_LOGIN_MAX_FAILURES` | `6` | Failures before lock |
| `RAG_TOP_K` | `5` | Retrieval top-k |
| `RAG_CANDIDATE_PAGE_SIZE` | `400` | Similarity scan page size |
| `RAG_HISTORY_LIMIT` | `12` | Prompt history cap |
| `RAG_TOKEN_TO_CHAR_RATIO` | `4` | Chunking ratio |
| `RAG_CHUNK_TOKENS` | `1000` | Chunk target tokens |
| `RAG_CHUNK_OVERLAP_TOKENS` | `200` | Chunk overlap tokens |
| `LOCAL_EMBEDDING_BATCH_SIZE` | `24` | Embedding batch size |
| `LOCAL_EMBEDDING_BATCH_SIZE_MIN` | `8` | Min adaptive batch |
| `LOCAL_EMBEDDING_BATCH_SIZE_MAX` | `64` | Max adaptive batch |
| `CLEANUP_INTERVAL_MS` | `900000` | Cleanup interval |
| `CLEANUP_COMPLETED_JOB_TTL_HOURS` | `24` | Completed job retention |
| `CLEANUP_FAILED_JOB_TTL_HOURS` | `72` | Failed job retention |
| `CLEANUP_TEMP_FILE_TTL_HOURS` | `6` | Temp upload retention |

## Project Structure
```text
.
├── docs/
├── scripts/
├── src/
│   ├── app.js
│   ├── server.js
│   ├── db/
│   ├── middleware/
│   ├── parsers/
│   ├── routes/
│   ├── services/
│   └── utils/
├── tests/
├── .env.example
├── openapi.yaml
├── package.json
└── README.md
```

## Development
Run app:
```bash
npm run dev
```

Run all tests:
```bash
npm test
```

Run migration dry-run:
```bash
npm run migrate:dry-run
```

## Notes
- Session deletion is hardened to remove DB records (sessions, PDFs, chunks, chat, related jobs) and uploaded files on disk.
- Route-level rate limiting and schema validation are enabled.
- Admin endpoints are blocked when `NODE_ENV=production`.

## License
ISC
