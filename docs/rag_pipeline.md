# RAG Pipeline

## Ingestion

1. User uploads supported file (`pdf`, `docx`, `csv`, `md`, `txt`).
2. Upload service validates:
- filename extension
- MIME type
- magic bytes/signature
3. File is persisted in `data/uploads/<sessionId>/<pdfId>.<ext>`.
4. `indexPdf` job is queued.

## Parsing and Chunking

- Parser selected by detected file type.
- Text is normalized and capped by `MAX_EXTRACTED_TEXT_LENGTH`.
- PDF page count is capped by `MAX_PDF_PAGES`.
- `chunkService` slices text with overlap.

## Embeddings

- Local ONNX model via `@xenova/transformers`.
- Batches are processed sequentially for memory safety.
- Vectors stored as JSON in `chunks.embedding` with dimensional metadata.

## Retrieval

- Query embedding generated locally.
- Candidate scan is paginated and bounded (`MAX_CHUNKS_PER_QUERY`).
- Cosine similarity scores are computed in-process.
- Top-k chunks are selected.

## Generation

- Prompt includes selected context and recent history.
- Gemini is called only for generation.
- If generation fails, a deterministic error answer is returned.
- If retrieval yields no context chunks but documents exist, Gemini falls back to answering general English questions using its own knowledge.
- If no documents exist in the session, the backend immediately returns a helpful auto-assistant message instructing the user to upload a document (`pdf`, `docx`, `csv`, `md`, `txt`) instead of attempting AI generation.

## Streaming

For SSE chat:
- emits `ready`
- emits periodic `progress`
- emits incremental `token`
- emits final `done` (contains standard answer schema and `sessionTitle`) or `error`

> **Note**: For both streaming and synchronous modes, the `sessionTitle` is only generated after the 2nd user message in a new chat. It may be refined automatically from the 6th message onward.
