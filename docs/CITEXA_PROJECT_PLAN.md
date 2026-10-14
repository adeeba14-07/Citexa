# Citexa — Complete Website Plan

## 1. Product overview

**Citexa is a source-grounded study companion for students.** Students organize course material, ask questions about their own sources, practice with adaptive quizzes, plan revision, and inspect exactly where study answers came from.

The product’s central promise is: **every course-based answer should be traceable to the learner’s uploaded material**. Citexa is not intended to guess what will be on a future exam or replace a teacher; it helps students make better use of their class notes, slides, textbooks, recordings, and past papers.

### Positioning

> For students managing several courses and scattered learning materials, Citexa turns those materials into a searchable, cited, and personalized study workspace—rather than a generic chatbot that answers without showing its evidence.

**Brand essence:** grounded, calm, capable.

## 2. The problem Citexa addresses

Students commonly face four related problems:

1. Notes, slide decks, textbooks, lecture recordings, and past papers are stored in separate places.
2. Generic AI explanations may not match a teacher’s material and may not show reliable sources.
3. Students need practice that responds to what they know, not just a fixed question list.
4. Revision schedules and previous learning sessions are easy to lose between visits or devices.

Citexa brings these tasks into a course-oriented workflow and makes the evidence visible.

## 3. Intended users and primary jobs

### Primary users

- Secondary, college, and university students studying from digital course materials.
- Independent learners who want structured practice and revision.
- Teachers or tutors who want to demonstrate material-grounded learning workflows (shared-course administration is future scope, not part of the current product).

### Core jobs to be done

- “Help me understand this idea from *my* lecture notes, and show me the page or slide.”
- “Give me practice on the concepts I have not mastered yet.”
- “Help me plan what to study before my exam and remember the plan.”
- “Show me which course topics appear in my selected past papers, without pretending to know the next exam.”
- “Let me review, export, or delete the study information associated with my account.”

## 4. Website structure and key pages

### Public and account entry

- **Landing page (`/`)** — explains the source-grounded study approach and directs users to the library.
- **Sign in / sign up** — account access in Clerk mode; local demo mode is available when configured.

### Learning workspace

- **Course library (`/user-portal`)** — lists a learner’s courses and provides course creation, course renaming, and confirmed course deletion.
- **Course detail (`/courses/:courseId`)** — course overview and source library. Learners add PDFs, PPTX slide decks, videos, and YouTube links; inspect processing status; open ready sources; rename source titles; remove sources; and retry failed ingestion where supported.
- **Study workspace (`/courses/:courseId/study/:tab?`)** — course study tools:
  - **Tutor** — gives friendly, complete explanations grounded in course sources, shows unobtrusive source chips, supports follow-up questions and previous chat history, and avoids leaking internal verification markers or sentence-level audit counters.
  - **Quizzes and assessment** — diagnostic, practice, mock, and short adaptive practice flows, with answer feedback and source references.
  - **Dashboard / learner progress** — summarizes course practice and mastery signals.
  - **Course map** — connects extracted topics and concepts and their prerequisites.
  - **Revision** — builds a spaced study schedule, saves plan history to the account, and lets the learner mark tasks complete.
  - **Exam Lab** — printable source-linked revision material, a course glossary, past-paper topic-priority ranking, and a daily goal that automatically progresses from first-time mastered concepts and completed-topic milestones.
- **Settings (`/settings`)** — saves a daily study goal, reminder-time preference, language preference, and accessibility choices (larger text, dyslexia-friendly font, high contrast); exports account and browser-local study data as JSON; and offers account data deletion.

## 5. Main learner journey

1. Create an account or enter the configured demo experience.
2. Create a course for each subject or class.
3. Upload or link course material and wait for ingestion to finish.
4. Ask questions in Tutor; open citations to verify the source passage, page, slide, or timestamp.
5. Use diagnostics and quizzes to practice. Quiz evidence updates the learner model.
6. Review the concept map, due queue, saved revision schedule, and Exam Lab as appropriate.
7. Return later to find saved conversations and schedules for that course.
8. Adjust personal study and accessibility preferences, export a copy, or request deletion from Settings.

## 6. Content ingestion and answer quality

The ingestion pipeline turns files into searchable course units while preserving their original location:

- PDFs are extracted page by page.
- PPTX files are extracted slide by slide.
- Videos and supported YouTube sources are transcribed and indexed with time ranges; frames and figures may be processed where supported.
- Extracted units are associated with sources, topics, concepts, and citations.
- Hybrid retrieval finds relevant units for tutor and study tools.
- Tutor replies can be requested in English, English (India), Hindi, Hinglish, Tamil, Telugu, Bengali, or Marathi. For non-English questions, the tutor can create a cached English search query to locate matching material while keeping the answer in the selected language; common subject acronyms such as ML are expanded for search.
- Tutor answers are structured around evidence and display citations that point back to the source.
- If the answer service is temporarily unavailable after matching source passages are found, the tutor keeps the chat working by returning cited excerpts from the uploaded material instead of a generic server error.
- Read-aloud and dictation use the browser/device speech services in the selected language when available; voice availability depends on installed language voices and browser support.
- Quiz questions are generated from course units, checked for answer quality, and associated with concepts and citations.

**Accuracy boundary:** source citations make answers auditable, but they do not guarantee that every model-generated explanation is correct. Students should check important information against their original materials and instructor guidance.

## 7. Past-paper coverage rules

Exam Lab’s predictor is a **historical coverage ranker**, not a forecast. Its meaning should remain explicit in the UI:

- It accepts selected, ready PDF/PPTX past papers from the current course.
- It compares extracted paper units with concepts linked to the course’s extracted topics.
- A topic’s priority score combines the share of selected papers containing its linked concepts (55%), its relative source-passage frequency within the results (30%), and breadth of linked concepts (15%). It is a transparent revision-priority index, not an observed probability.
- Results should retain citations/evidence links so learners can inspect what matched.
- Results should label high-priority topics as useful revision candidates; no score should be presented as the probability that a topic will appear on the next exam.
- The previous arbitrary 20-paper cap has been removed; practical payload/database capacity still applies.

## 8. Data and persistence plan

### Server-side account data

PostgreSQL holds account-owned courses and learning records, including source metadata, extracted units, conversations and chat messages, assessments, quizzes, mastery evidence, settings, and saved revision plans. Course ownership is checked by the API before access. Saved plans are scoped to both their owner and course; task completion is saved with the plan.

Uploaded files and derived previews use the project’s storage layer. A deployment should configure persistent storage (or its database-backed file option) if uploads and generated previews must survive service restarts.

### Browser-local data

Some daily XP and streak/progress details remain in the current browser’s local storage and are not synchronized across devices. The Settings export includes these browser-local study records from the device performing the export. The data-delete action removes the server’s account-owned course data and the local Citexa study keys in that browser; it cannot reach local storage on another device that is offline or not being used.

### Database setup after an update

The project requires PostgreSQL with `pgvector`. After extracting the project, configure `.env` using `.env.example`. On a fresh database, run `pnpm run setup` once to enable pgvector and create the base schema. On an existing database with Citexa’s base schema installed, start with `pnpm run dev`; the API additively prepares the account settings and saved-plan tables. The API’s `/api/healthz` endpoint checks database connectivity and required conversation/settings/plan tables.

## 9. Technical architecture

- **Frontend:** React, TypeScript, Vite, Tailwind CSS, Wouter routing, TanStack Query, and generated API-client hooks.
- **Backend:** Express and TypeScript API, with request validation, account ownership checks, file handling, ingestion jobs, chat, and study-tool routes.
- **Database:** PostgreSQL, Drizzle ORM, and pgvector for structured learning data and retrieval support.
- **AI services:** Groq-hosted language, validation, vision, and transcription models (configured via environment variables).
- **Browser speech:** Web Speech API for read-aloud and dictation, using installed device voices and locale support.
- **Local processing:** Python tooling through `uv` for PDF, PowerPoint, and video-related extraction; ffmpeg and LibreOffice are optional system dependencies for applicable media paths.
- **Development:** `dev.mjs` loads `.env` and launches the API and Vite frontend together; the Vite frontend proxies `/api` to the API service.

### Main code areas

| Area | Responsibility |
|---|---|
| `artifacts/studygraph/src/` | User-facing application, routes, library, study tools, and settings |
| `artifacts/api-server/src/routes/` | HTTP endpoints for courses, source ingestion, tutor/chat, assessments, adaptive study, tools, and account data |
| `artifacts/api-server/src/lib/` | Ownership rules, retrieval, ingestion workers, AI integrations, and storage |
| `lib/db/src/schema/` | Drizzle definitions for course, adaptive-learning, settings, and saved-plan tables |
| `lib/api-client-react/` | Generated API types/hooks used by the frontend |
| `docs/` | Product, architecture, grounding, and learner-model documentation |

## 10. Design and interaction principles

### Visual direction

A warm, editorial study journal: quiet enough for long reading, but structured enough to make sources and progress easy to scan.

- **Palette:** deep forest green for primary actions and learning identity; warm ivory for the reading surface; restrained ochre/amber for source labels and attention; muted sage for progress and success states.
- **Typography:** expressive editorial headings paired with a clear, compact sans-serif body and monospaced micro-labels for metadata.
- **Layout:** a calm course library and flexible, responsive study surfaces that prioritize readable material over decorative chrome.
- **Signature motifs:** small source-location chips, thin journal-like dividers, and understated paper-grid/soft-surface treatments.
- **Interaction:** actions should be direct, state should be visible, destructive course/data deletion should require confirmation, and source status should never be presented as “ready” until processing actually succeeds.
- **Accessibility:** keyboard-visible focus, useful labels for icon-only buttons, readable line lengths, reduced motion where available, larger text, dyslexia-friendly typography, and high-contrast mode.

### Brand voice

- **Voice:** precise, encouraging, and honest about evidence and limits.
- **Example:** “Your materials cover this topic on slides 8 and 11.”
- **Example:** “This shows past-paper coverage—not a promise about your next exam.”

## 11. Reliability and support priorities

The core product should favor dependable records and actionable failures over silent fallbacks:

1. Confirm `DATABASE_URL`, run schema setup after a version update, and expose database readiness clearly.
2. Show loading, empty, error, and retry states for chat history and saved plans.
3. Keep API failures observable in API logs while returning safe, actionable messages to the interface.
4. Keep course, chat, and plan history scoped correctly to the signed-in owner.
5. Avoid language that overstates AI certainty or the predictive meaning of past-paper frequency.

## 12. Roadmap

### Now — reliable study workflow

- Durable account-scoped course, conversation, and revision-plan history.
- Readable failure states and database/schema diagnostics.
- Course/source editing and confirmed deletion.
- Accessible preferences, account export, and data deletion.

### Next — better learner continuity

- Persist daily XP and streaks server-side so progress follows the learner between devices.
- Add fully localized interface translations for supported languages (separate from the current saved language preference).
- Add opt-in reminders through an explicit browser notification or scheduled-notification design.
- Improve plan history management (rename/archive/delete a single plan) and allow account export/import validation.

### Later — educator and cohort workflows

- Shared course spaces with explicit roles and permissions.
- Instructor-created course packs and structured assignment workflows.
- Aggregate cohort insights that protect individual learner privacy.

## 13. Non-goals and honest limitations

- Citexa does not guarantee grades or learning outcomes.
- Past-paper ranking does not predict exact exam questions.
- Saved reminder times do not currently trigger background push notifications.
- A selected language preference does not translate every interface label.
- Read-aloud and dictation depend on the voices and speech-recognition locales installed or supported by the learner’s browser/device.
- Shared-course roles, offline synchronization, and multi-device XP sync are not currently implemented.
- An account data deletion request cannot reach browser storage on an inactive, separate device.
