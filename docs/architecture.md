# Architecture

## Overview

Document Analyzer RAG is a layered Node.js backend:

- `routes` define HTTP endpoints.
- `controllers` orchestrate request flows.
- `services` handle business/domain logic.
- `parsers` extract normalized text by file type.
- `database` handles migrations and SQLite persistence.

## Request Flow

1. Request enters `src/app.js` middleware stack (helmet, CORS, body parsers, rate limiting).
2. Router dispatches to `/api/v1` modules.
3. Controller validates/authenticates and calls service methods.
4. Services query SQLite through prepared statements.
5. Responses use unified `{ ok, data }` or `{ ok: false, error }` format.

## Data Model (SQLite)

Primary tables:
- `users`
- `auth_sessions`
- `refresh_tokens`
- `sessions`
- `pdfs`
- `chunks`
- `chat_messages`
- `job_queue`
- `email_otps`
- `password_reset_otps`

## Async Jobs

`jobQueue` processes:
- `indexPdf` jobs (parse/chunk/embed/store)
- `chatQuery` jobs (for large-history/large-context chat)

Queue state is persisted to SQLite and recoverable on restart.

## Streaming

Chat streaming uses Server-Sent Events (SSE):
- `Content-Type: text/event-stream`
- buffered output disabled
- explicit `done`/`error` termination events

## Logging

Structured JSON logs are emitted from `src/config/logger.js` with fields:
- `ts`, `level`, `event`, plus metadata.
