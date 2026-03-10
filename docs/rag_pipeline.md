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
- If generation fails or no context exists, deterministic fallback answer is returned.

## Streaming

For SSE chat:
- emits `ready`
- emits periodic `progress`
- emits incremental `token`
- emits final `done` or `error`
