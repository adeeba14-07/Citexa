# Citexa setup (Windows)

**Citexa — Every answer, cited to the source.**

## Requirements
- Node.js LTS
- pnpm
- Python 3.13 (for document extraction)
- `uv` (Python environment and extraction dependencies)
- A PostgreSQL/Neon database with pgvector available
- A Groq API key
- Clerk keys if using real sign-in (`DEMO_MODE=false`)

## Configure
1. Copy `.env.example` to `.env` in this folder.
2. Fill `DATABASE_URL`, `GROQ_API_KEY`, `STORAGE_SECRET`, and the Clerk keys.
3. Keep `.env` private. Never commit it or paste its values into chats.
4. Ensure `DEMO_MODE=false` for real Clerk auth. Demo mode is only for local UI testing and is not the production configuration.

## Install and run (PowerShell)
Open a terminal in this folder and run:

```powershell
pnpm.cmd install
pnpm.cmd run dev
```

Open `http://localhost:5173`. Leave the terminal running. If your terminal reports another port, use the URL printed in the terminal.

If the database schema has not been initialized, stop the server and run:

```powershell
node dev.mjs --setup
```

Then restart with `pnpm.cmd run dev`.

## AI and embeddings
- Chat, source structuring, quiz generation, answer verification, and Groq-compatible transcription use `GROQ_API_KEY` through Groq's OpenAI-compatible API endpoint.
- Embeddings are generated locally with deterministic 1,536-dimensional feature hashing to avoid a paid embeddings API and preserve the current pgvector schema. This is a lightweight lexical feature representation, not a neural semantic embedding model. Lexical full-text retrieval is also retained, and the app's citations must come from retrieved course units.
- Groq free-tier availability, model access, and rate limits depend on the account and can change. The app needs a valid key and database connection to use real AI and persisted content.

## Windows notes
The root `preinstall` script that used Unix `sh` has been removed for Windows compatibility. The ingestion worker invokes `python` inside the `uv run` environment rather than `python3`.

## Security
The ZIP intentionally excludes `.env`, `node_modules`, local uploads, and build artifacts. Use your own credentials. Rotate any credentials that were previously exposed in screenshots or uploaded archives.
