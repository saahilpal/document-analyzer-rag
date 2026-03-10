# System Limits

Default limits are environment-driven and configurable in `.env`.

## Upload and Parsing

- `MAX_UPLOAD_FILE_SIZE_BYTES=31457280` (30MB)
- `MAX_DOCS_PER_SESSION=5`
- `MAX_PDF_PAGES=150`
- `MAX_EXTRACTED_TEXT_LENGTH=2000000`

## Retrieval and Chat

- `MAX_CHUNKS_PER_QUERY=2000`
- `RAG_TOP_K=5`
- `RAG_CANDIDATE_PAGE_SIZE=400`
- `RAG_HISTORY_LIMIT=12`

## Request Safety

- `MAX_REQUEST_BODY_SIZE_BYTES=2097152` (2MB JSON/urlencoded bodies)
- route-level rate limits for read/write/upload/chat/auth

## Worker and Resource Controls

- bounded embedding batch sizes
- paginated vector scan with event-loop yielding (`setImmediate` between pages)
- cleanup worker for stale jobs, stale temp files, orphan chunks, expired auth sessions

## Why These Limits Exist

- protect memory and CPU on local deployments
- prevent abuse and oversized payload attacks
- maintain predictable latency under concurrent usage
