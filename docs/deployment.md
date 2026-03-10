# Deployment Guide

## 1. Prerequisites

- Node.js 20+
- writable disk for `data/`
- outbound network for Gemini generation calls

## 2. Environment Setup

1. Copy `.env.example` to `.env`.
2. Set strong secrets (`JWT_SECRET`, SMTP credentials, Gemini key).
3. Set `NODE_ENV=production`.
4. If behind proxy/load balancer, set `TRUST_PROXY=true`.

## 3. Build and Start

```bash
npm ci
npm run migrate
npm run start
```

## 4. Process Supervision

Use one of:
- `systemd`
- `pm2`
- container orchestrator

Restart policy should be enabled.

## 5. Reverse Proxy

Recommended fronting with Nginx/Caddy/Cloudflare Tunnel.

Required for SSE routes:
- disable response buffering on streaming endpoint paths
- keep connection timeouts high enough for long-running streams

## 6. Persistence and Backups

Persist:
- `data/studyrag.sqlite`
- `data/uploads/`

Back up SQLite and uploads together to keep referential consistency.

## 7. Security Checklist

- do not commit `.env`
- rotate `JWT_SECRET` and Gemini key regularly
- restrict CORS via `CORS_ALLOWED_ORIGINS`
- keep upload and request size limits enabled
- run behind HTTPS terminator/proxy

## 8. Health and Operations

- Liveness: `GET /api/v1/ping`
- Health: `GET /api/v1/health`
- Monitor logs for `ERROR_*` events
- Cleanup worker runs periodically (env-configured)
