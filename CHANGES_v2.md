# Citexa update: what changed and how to test it

No database changes, no new dependencies, no API-contract (OpenAPI) changes. Your `.env` is not touched.

## 1. YouTube sources no longer fail with "Model returned no parseable JSON"
- `artifacts/api-server/src/lib/ingestion/worker.ts`
  Topic building used to be all-or-nothing: one bad AI answer in any batch failed the whole source,
  even though all its study units were already saved. Now a failed batch is retried as two smaller
  batches, then skipped. After 3 failed sections in a row it stops spending API calls. The source is
  marked Ready (the tutor works) and says honestly if the topic map is partial. Progress now moves
  during this step instead of sitting at 76%.
- `artifacts/api-server/src/lib/ingestion/ai.ts`
  The error now says what the model actually returned (model name, finish reason, first characters),
  so any future failure can be diagnosed from the source row.
- To fix your existing "AIML" source: press **Retry processing** once after restarting.

## 2. Friendly tutor chat
- `artifacts/api-server/src/routes/tutor.ts`
  - "hello", "thanks", "who are you", "what can you do", "bye" get a warm reply (no warning card),
    with tappable suggested questions built from your course's own topics.
  - "Not covered" answers are kinder and tell the student what the course does cover.
  - Follow-ups ("explain simpler", "give an example", "why?") are linked to the previous
    question, the previous answer and the units it cited.
- `artifacts/studygraph/src/study/TutorChat.tsx`
  Friendly card styling, suggestion chips, one-tap follow-ups (Explain simpler / Give an example /
  Go deeper), starter chips on an empty chat, auto-growing input, mobile-safe input size.

## 3. Clicking a source shows the real PDF page
- New: `routes/sourceview.ts`, `lib/ingestion/render.ts`, `lib/ingestion/render_page.py`
  `GET /api/x/sources/:id/page/:n/image` returns the stored page image, or re-renders the page from
  the stored original PDF with PyMuPDF (already a dependency) if no preview was stored. Renders are cached.
- `artifacts/studygraph/src/study/common.tsx`
  The viewer shows the actual page with Prev / Next navigation (also arrow keys), a loading skeleton,
  the cited text, and "Open the original file at page N". If rendering is impossible it falls back to
  the browser's PDF viewer, then to a clear message.
- `artifacts/studygraph/src/App.tsx`
  In the Source library, every Ready source has a **View / Watch** button and a clickable title.
- If a source was uploaded on another computer and its file is gone from this machine, nothing can
  show it: upload it again once.

## 4. Mobile
- Installable web app (`public/manifest.webmanifest`, icons, iOS meta tags): "Add to Home screen".
- Viewport allows pinch-zoom; 16px inputs stop iOS zoom-on-focus; safe-area padding for notches.
- To try it on your phone while developing: open `http://<your-PC-IP>:5173` on the same Wi-Fi
  (allow Node through the Windows firewall if asked).

## Quick test list
1. Restart `pnpm run dev`. Press **Retry processing** on the failed YouTube source: it should reach Ready.
2. Tutor: type `hello`, then `thanks`: friendly replies, no yellow warning.
3. Ask a course question, click a source chip: the real page appears; try Prev / Next.
4. Library: click **View** on Lecture01.
5. Ask `explain simpler`: it should stay on the same topic.
