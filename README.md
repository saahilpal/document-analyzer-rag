# Document-Analyzer-RAG 🚀

An authentication-free, local-first backend API for high-performance Retrieval-Augmented Generation (RAG) using Node.js, Express, better-sqlite3, and Google Gemini.

Designed for robust deployment with automated Cloudflare Tunnels, zero-dependency local vector embeddings (via Xenova), and full streaming chat endpoints. Ideal for developers needing a plug-and-play AI-powered document QA system securely stored entirely on local disk.

---

## ✨ Features

- **Local Vector Store:** Zero database dependencies. Uses a fast, transactional `better-sqlite3` pipeline storing native Float32Array blob buffers directly on your filesystem.
- **On-Device Embeddings:** Uses Xenova/transformers (`Xenova/all-MiniLM-L6-v2`) inside the Node.js process to convert document text into semantic vectors without hitting external APIs or incurring latency.
- **Enterprise-Grade Authentication Pipeline:** Full JWT rotation, rolling device tracking, auto-expiring background auth garbage collection, and OTP-based password resets via NodeMailer.
- **Automated Queuing Pipeline:** In-memory + SQLite-backed asynchronous job worker handles large PDF chunking safely with automatic batch-sizing adjustments and crash-recovery.
- **Full Chat Streaming (SSE):** Near-instant Server-Sent Events chat response generation securely routed directly from Gemini 2.5 Flash.
- **Auto-Title Generation:** Gemini automatically reads the first contextual user message to name fresh chat sessions asynchronously to keep UX fast.
- **Automated Tunnel Infrastructure:** Built-in `start-tunnel.sh` Cloudflare proxy script with auto-healing and a zero-downtime React frontend JSON configurator sync mechanism.

---

## 🏗️ Architecture Overview

The system operates strictly on a modular, service-based MVC structure:

1. **Authentication:** Employs OTP-based stateless JWT session trees. Users register, login, and verify using 6-digit email codes (simulated or SMTP). Sessions track IP and device fingerprinting to permit remote session revocation.
2. **File Storage & Indexing:** PDFs are ingested via Multer to temporary disk. The `jobQueue.js` assigns a background task to `pdf-parse` the document, tokenize the text via HuggingFace's on-device transformer model, and stream SQLite vector embeddings into local storage.
3. **Queue System:** Built on a resilient hybrid model. Jobs are tracked in an SQLite `job_queue` table but processed in raw memory arrays. If the server crashes, an auto-boot recovery script reinstates pending jobs and resumes indexing natively.
4. **Chat & RAG:** Users push chat queries to sessions. The `ragService.js` performs Cosine Similarity against local SQLite blobs, injects the top matching context into a Gemini model prompt, and streams responses to clients using standard `text/event-stream` format.
5. **Garbage Collection:** A configurable background worker dynamically sweeps the `auth_sessions`, `job_queue`, and temp `/uploads` directories to prune orphaned artifacts and prevent server leakage.

---

## 💻 Tech Stack

- **Runtime:** Node.js (Express.js)
- **Database:** SQLite (`better-sqlite3`)
- **LLM Provider:** Google GenAI SDK (Gemini-2.5-Flash)
- **Embeddings Pipeline:** `@xenova/transformers`
- **Email:** `nodemailer`
- **Storage Management:** `multer`, `pdf-parse`

---

## 🛠️ Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/your-username/document-analyzer-rag.git
   cd document-analyzer-rag
   ```

2. **Install local dependencies:**
   ```bash
   npm install
   ```

3. **Configure the Environment:**
   Copy the example config and inject your Gemini and SMTP keys.
   ```bash
   cp .env.example .env
   ```
   > **Note:** The backend *will* crash on boot if `GEMINI_API_KEY` is not explicitly set in `.env`.

4. **Initialize Database Migrations:**
   ```bash
   npm run migrate
   ```

5. **Start the Development Server:**
   ```bash
   npm run dev
   ```

---

## ⚙️ Environment Setup (`.env`)

The project ships with an aggressively documented `.env.example` file. Key architectural variables include:

### Server & AI
- `GEMINI_API_KEY`: Highly required. Without this, RAG streaming faults globally.
- `PORT` / `HOST`: Standard binding configs.
- `LOCAL_EMBEDDING_BATCH_SIZE`: Tunes the native Xenova chunking matrix. Decrease from `24` if your RAM is limited.

### Tuning the Indexer
- `RAG_CHUNK_TOKENS` (Default 1000): Determines document slice density.
- `RAG_CHUNK_OVERLAP_TOKENS`: Mitigates semantic meaning dropping at page fractures.

### Worker & Housekeeping
- `CLEANUP_INTERVAL_MS`: Defaults to 15 minutes to run full DB garbage collection loops.

---

## 🚀 Running Locally

- **Production Sync Mode:**
  ```bash
  npm run start
  ```
- **Live-Reload Dev Mode:**
  ```bash
  npm run dev
  ```
- **Remote Cloudflare Tunneling:**
  Using the bundled DevTools, you can easily proxy your local `4000` port to the public web for remote frontend consumption.
  ```bash
  # Boots tunnel, automatically intercepts public trycloudflare URL, and pushes configuration tracking to Github
  AUTO_PUSH_TUNNEL_URL=true bash devtools/tunnel/start-tunnel.sh
  ```
  *(See `dev-runtime/backend-url.json` for live dynamic frontend mapping).*

---

## 📖 API Reference (Core Routes)

All routes are prefixed under `/api/v1`. Route-level JWT auth (`Authorization: Bearer <token>`) is required generically post-login.

### Authentication
- `POST /auth/register` - Registers and transmits 6-digit verification OTP.
- `POST /auth/verify-otp` - Activates the email address.
- `POST /auth/login` - Resolves identity and initializes cross-device JWT session.
- `POST /auth/refresh` - Mints new scoped access token manually without re-auth.
- `POST /auth/request-reset` / `POST /auth/reset-password` - Unified OTP recovery flow.

### Chat & Sessions
- `POST /sessions` - Initializes a new semantic chat hierarchy.
- `GET /sessions/:sessionId` - Dumps current metadata, including uploaded indexing artifacts.
- `POST /sessions/:sessionId/chat` - Generates LLM response based on semantic vector matching.
  - Supports `stream=true` queries to resolve HTTP Event Stream pipelines.
- `GET /sessions/:sessionId/history` - Restores historical contexts with cursor pagination limits.

### Documents & Ingestion
- `POST /sessions/:sessionId/pdfs` - Streams `multipart/form-data` payloads to disk, instantiates a background `jobQueue` vector indexing worker immediately, and returns a job telemetry ID.
- `GET /jobs/:jobId` - Polling endpoint for client UX loaders tracking the ingestion worker progress percentages and error blocks.

---

## 🛡️ Security Design

1. **Hybrid Identity Matrix:** Active tracking ties user sessions heavily to generic device and IP fingerprints, ensuring proactive manual session invalidations operate strictly.
2. **CORS Hardening:** Standard endpoints bind generic localhost configs but block dynamic or wildcards out-of-the-box (`process.env.CORS_ALLOWED_ORIGINS`).
3. **Payload Sanitization:** Route limits enforce aggressive global payload ceilings (2MB standard, Multer overriding explicitly to 50MB purely parsing streams).
4. **Data Isolation:** All session artifacts, PDF buffers, user meta, and native SQLite nodes map safely locally. No cloud external vector datastores exist.

---

## 🧬 Development Workflow

- Run entire test suite: `npm run test`
- Run integration isolated pipeline: `npm run test:integration`

We strongly adhere to standard `commitlint` (e.g., `feat(auth):`, `fix(rag):`, `chore(tunnel):`) for commit history layout to support fluid changelog generations.

---

## 📁 Folder Structure

```
├── .env.example                # Base configurations tracking parameters
├── data/                       # Local volume storing db.sqlite buffers
├── dev-runtime/                # Autogenerated frontend bindings for tunnel URLs
├── devtools/tunnel/            # Bash orchestration for cloudflared exposure
├── scripts/                    # Schema migrations and bootstrapping
├── src/
│   ├── app.js                  # Express pipeline & global middleware
│   ├── db/                     # SQLite drivers and blob abstraction models
│   ├── middleware/             # Rate Limiter definitions and generic logic validators
│   ├── routes/                 # Explicit Express router interfaces
│   ├── services/               # Complex logic containing Vector Stores, LLM bridges etc.
│   └── utils/                  # Zod schema definitions and native logger outputs
└── tests/                      # Extensive Node.js native (`node:test`) assertions
```

---

## 🔍 Troubleshooting

- **`SQLITE_ERROR: no such table`**: Ensure you have successfully seeded your local file map with `npm run migrate`.
- **`GPU Out Of Memory / Worker Hang`**: Xenova's default `LOCAL_EMBEDDING_BATCH_SIZE=24` may crush lightweight containers (specifically those under 1GB RAM limits). Drop safely to `8` in `.env`.
- **`Error: Invalid JSON body`**: Validate that requests routing PDF files use strict `multipart/form-data` instead of native Express generic parsing logic.
- **`SSE Chunk Failing`**: In a public hosting environment proxying across NGINX, `proxy_buffering off` must be configured for the backend mapping explicitly, otherwise chunks pool up locally returning generically chunked answers.

---

## 🚀 Future Improvements

- Map semantic routing capabilities utilizing more extensive external vector-db drivers for multi-tenant high availability.
- Allow generic HTML/DOCX ingestion dynamically parallel utilizing integrated mammoth loaders.
- Improve system telemetry outputs bridging with Grafana/Prometheus metric scrapes natively.
