# Citexa: source-grounded adaptive study companion

Track D, Multimodal AI Hackathon 2026. Upload lecture videos, textbooks and slides; get a tutor whose
every answer cites the exact page, slide or video moment, plus adaptive quizzes and a learner model.

## Features
| Requirement | Where |
|---|---|
| 1 Multimodal knowledge base (PDF/PPTX/video/YouTube, figure captions, topics → concepts → prerequisites, every unit linked to page/slide/timestamp) | `artifacts/api-server/src/lib/ingestion/` |
| 2 Source-grounded tutor, clickable citations, refusal of uncovered questions, labeled outside knowledge | `routes/tutor.ts`, `study/TutorChat.tsx`, `study/common.tsx` |
| 3 Adaptive assessment: MCQ / short answer / numerical, topic+source+difficulty tags, cross-model verification, repeat detection, cited feedback, report with misconceptions | `lib/adaptive/quiz.ts`, `lib/adaptive/grading.ts` |
| 4 Learner model: Bayesian Knowledge Tracing + forgetting curve, chat evidence, prerequisite propagation, diagnostic for new students | `lib/adaptive/bkt.ts`, `routes/adaptive.ts` |
| 5 Evaluation: RAGAS, citation/refusal metrics, simulated students, key audit | `eval/` |
| 6 Optional: course map, flashcards, account-saved study plans and chat history, Hindi and Indian-language answers, voice in/out, account settings, and Exam Lab (cited revision sheets, glossary, past-paper coverage) | `study/` |

See [the complete product plan](docs/CITEXA_PROJECT_PLAN.md) for the website’s audience, purpose, user journeys, features, architecture, data model, design principles, limitations, and roadmap.

## Run it locally
You need: Node 22+, pnpm, Python tooling via [uv](https://docs.astral.sh/uv/), ffmpeg, and LibreOffice
(only for PPTX slide images). Works on native Windows (PowerShell) or WSL2.

```bash
pnpm install
cp .env.example .env        # then fill in DATABASE_URL and GROQ_API_KEY
pnpm run setup              # enables pgvector + creates tables
pnpm run dev                # API on :3001, web app on :5173
```
Open http://localhost:5173. No sign-up is needed (demo mode). Add Clerk keys and `DEMO_MODE=false` for real accounts.

On a fresh database, run `pnpm run setup` once to create the base Citexa schema. On an existing database with the base schema already installed, start with `pnpm run dev`; the API additively prepares the account settings and saved-plan tables. Study schedules and task completion are stored per account; **Settings** includes study goals, preferences, a JSON account export, and delete-my-data. Daily goal progress now also updates from first-time concept mastery and completed-topic milestones. Course/source names can be changed in the library. The past-paper guide prioritizes topics using repeated-paper coverage, source-passage frequency, and linked-concept breadth; it is a revision aid, not a guarantee about the next exam.

**Database:** any Postgres with the `pgvector` extension. Easiest is a free Neon project; paste its connection string.

## Using it
1. Create a course, then upload PDFs, PPTX, videos, or paste a YouTube link. Wait for "ready".
2. Open **Study workspace**. Take the **diagnostic** quiz first so practice can adapt.
3. Ask questions in the **Tutor**; use the source chips beneath an answer to open its exact page/slide/timestamp.
4. Use **Quizzes**, **Dashboard**, **Course map**, **Revision**, and **Exam Lab**. Cheat sheets can be printed or saved as PDF. Add past papers in the source library, wait for Ready, then select those PDFs/PPTX decks in the predictor.

## Evaluation
See `eval/README.md`. Run `python build_testset.py`, review the set, then `run_eval.py`, `simulate_students.py`, `audit_keys.py`.

## Docs
`docs/ARCHITECTURE.md`, `docs/GROUNDING.md`, `docs/LEARNER_MODEL.md`.

## Honest limitations
- Cross-model verification uses two different Groq-hosted models; that reduces but does not remove correlated errors.
- Hindi/Hinglish answers rely on the language model; retrieval combines full-text search with local hash embeddings by default. Optional multilingual semantic search (a local multilingual-e5-small model, no API cost) can be enabled with `node enable-semantic.mjs`, so Hindi and Hinglish questions can find English sources.
- Audio tutoring uses the browser's built-in speech APIs (Chrome/Edge work best).
- Simulated-student results depend on the simulator's assumptions and are not evidence of real learning gains.


## Local Windows setup

See [CITEXA_SETUP.md](CITEXA_SETUP.md) for the Windows setup, Groq configuration, and troubleshooting notes.


## Troubleshooting (most common)
| Symptom | Fix |
|---|---|
| `429 Rate limit ... tokens per minute` | Handled automatically now (waits and retries; text-only pages skip the vision model). If it persists, set `CITEXA_VISION_MODE=off` or raise `CITEXA_VISION_GAP_MS`, then press **Retry processing** on the source. |
| YouTube: `No supported JavaScript runtime` / `format is not available` | Run `uv sync` once, restart `pnpm run dev`. If YouTube still blocks, set `YTDLP_COOKIES_BROWSER=chrome` in `.env` (be signed in to YouTube in that browser, close it first), or upload the MP4 directly. |
| PPTX fails | Install LibreOffice, or export the deck to PDF and upload that. |
| Source stuck as failed | Press **Retry processing** on the source row. |
| Vite proxy `ECONNREFUSED` for `/api` | Vite is running but the API is not listening. Stop the frontend-only command and run `pnpm run dev` from the repository root; inspect `[api]` logs and verify `DATABASE_URL` and `API_PORT` in `.env`. See `RUN_AND_TROUBLESHOOT.md`. |


### Optional: multilingual semantic search
Run `node enable-semantic.mjs` once, then restart `pnpm run dev`. The first start downloads the model (about 120 MB) and re-indexes your existing study units in the background; watch the API terminal for `[embeddings]` lines. The tutor stays usable while this happens (it uses keyword search until the model is ready). To turn it off, set `CITEXA_EMBEDDINGS=hash` in `.env`. Quiz de-duplication keeps using the lightweight hash embeddings.
