# API Reference

Base path: `/api/v1`

All protected routes require:

```http
Authorization: Bearer <accessToken>
```

## Health

- `GET /health` : service health, queue and runtime stats
- `GET /ping` : liveness check

## Auth

- `POST /auth/register`
- `POST /auth/send-otp`
- `POST /auth/verify-otp`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/request-reset`
- `POST /auth/reset-password`
- `GET /auth/me` (protected)
- `POST /auth/change-email` (protected)
- `POST /auth/change-email/verify` (protected)
- `GET /auth/sessions` (protected)
- `DELETE /auth/sessions/:sessionId` (protected)
- `DELETE /auth/session` (protected)

## Sessions

- `GET /sessions` (protected)
- `POST /sessions` (protected)
- `GET /sessions/search?q=<query>` (protected)
- `PATCH /sessions/:sessionId` (protected)
- `GET /sessions/:sessionId/meta` (protected)
- `GET /sessions/:sessionId` (protected)
- `DELETE /sessions/:sessionId` (protected)

## Documents

- `POST /sessions/:sessionId/pdfs` (protected, multipart `file`)
- `GET /sessions/:sessionId/pdfs` (protected)
- `GET /pdfs/:pdfId` (protected)
- `DELETE /pdfs/:pdfId` (protected)

## Chat

- `POST /sessions/:sessionId/chat` (protected)
- `POST /chat` (protected, body must include `sessionId`)
- `GET /sessions/:sessionId/history` (protected)
- `DELETE /sessions/:sessionId/history` (protected)

Streaming mode:
- add `?stream=true` and `Accept: text/event-stream`

## Jobs

- `GET /jobs/:jobId` (protected)

## Error Format

```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Readable message",
    "retryable": false
  }
}
```
