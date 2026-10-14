# Architecture

```
Browser (React + Vite)
  Library ── Study workspace: Tutor + saved chat history | Quizzes | Dashboard | Course map | Revision | Exam Lab
  Settings: account preferences, export and data deletion
        │  /api (Vite proxy in dev)
Express API (TypeScript)
  routes/studygraph.ts   courses, sources, ingestion jobs, uploads
  routes/tutor.ts        grounded chat (retrieval → structured answer → citation check)
  routes/adaptive.ts     adaptive quizzes, mastery, graph, units, flashcards, account-saved plans, chat evidence
  routes/account.ts      account settings, account data export/deletion
  lib/ingestion/         worker: extract → figures → chunk → structure → tag → embed
  lib/adaptive/          quiz.ts (generate + verify + dedupe), grading.ts, bkt.ts, mathExpr.ts
        │
PostgreSQL + pgvector      Local disk (uploads, rendered page/slide images)
Groq: generator model, validator model, vision, transcription. Embeddings run locally (multilingual-e5-small via ONNX, with hash fallback).
Python (uv): PyMuPDF, python-pptx, yt-dlp   ffmpeg / LibreOffice for video + slides
```

## Ingestion
1. A source is uploaded (signed local upload URL) or linked (YouTube) and an ingestion job is queued; progress is persisted.
2. PDFs and PPTX are parsed per page/slide with images rendered; videos are transcribed with timestamps and keyframes extracted.
3. Figures and diagrams are captioned by a vision model and stored as searchable units at their exact location.
4. Every unit stores a **locator** (`page`, `slide`, or `start_sec/end_sec`) and its source.
5. An LLM builds topics → concepts → prerequisite edges across sources; each unit is tagged to concepts and embedded (pgvector, HNSW).

## Data model (main tables)
`sources`, `units(locator, embedding)`, `topics`, `concepts`, `concept_edges`, `unit_concepts`,
`quizzes`, `quiz_questions(type, key, difficulty, concept_ids, unit_ids, citations, misconceptions, verification, embedding)`,
`quiz_attempts`, `bkt_mastery(p_known, stability, next_review_at)`, `bkt_events(source, before, after)`, `misconception_log`, `conversations`, `conversation_messages`, `studygraph_user_settings`, and `studygraph_saved_plans`.

Run `pnpm run setup` after applying a schema update to an existing database. `/api/healthz` verifies connectivity and the required conversation/settings/saved-plan tables; the API logs include diagnostic details for unhandled errors.

## Request flows
- **Ask**: embed question → hybrid retrieval → structured answer (`answerable`, cited unit ids) → unsupported answers are replaced with a refusal and carry no citations.
- **Quiz**: choose concepts (BKT priority / diagnostic round-robin) → generate from their units → verify with a second model → drop repeats → store → grade → update BKT → report.
