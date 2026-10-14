# Deploying Citexa on Render

Local development (`pnpm run dev`) is unchanged. These files are only used by Render:
`Dockerfile`, `.dockerignore`, `render.yaml`. One Render service runs the API and serves the web app.

## Before you start
- Your Neon database already has the tables (you ran `pnpm run setup` locally). Render uses the same database, so your courses and sources are still there.
- Use your Clerk **development** keys (`pk_test_...` / `sk_test_...`). Production Clerk keys need your own custom domain, which `onrender.com` is not.
- Uploaded files are stored on disk. Render only keeps files across restarts if you attach a **persistent disk** (a paid plan). Without it, uploaded files disappear on restart and citations that open a page will break.

## Steps
1. **Put the project on GitHub** (a private repo is fine). `.env` is already in `.gitignore`, so your keys are not uploaded. Check this after pushing: `.env` must not appear in the repo.
2. On https://render.com, choose **New > Blueprint** and select the repo. Render reads `render.yaml`.
   (Or: **New > Web Service > Docker**, then add the variables below by hand.)
3. Fill in the environment variables when asked:

| Name | Value |
|---|---|
| `DATABASE_URL` | same as your local `.env` |
| `GROQ_API_KEY` | same as your local `.env` |
| `CLERK_PUBLISHABLE_KEY` | `pk_test_...` from `.env` |
| `VITE_CLERK_PUBLISHABLE_KEY` | the **same** `pk_test_...` value (it is built into the web page) |
| `CLERK_SECRET_KEY` | `sk_test_...` from `.env` |

   `STORAGE_SECRET` is generated for you. `DEMO_MODE` is `false`.
4. Click **Apply / Deploy**. The first build takes roughly 10 to 15 minutes.
5. Open the `https://<your-name>.onrender.com` address, sign up, and test: upload a PDF, ask a question, click a citation.

## Good to know
- **Free plan:** it sleeps when idle (first visit is slow) and has no disk. Remove the `disk:` block and set `plan: free` in `render.yaml` if you only want a quick test. Check Render's pricing page for current plans.
- **Memory:** if processing a big PDF or video crashes with "out of memory", move to a plan with more RAM.
- **PowerPoint files:** the image does not include LibreOffice (it makes the build much bigger). To enable it, add a build argument `INSTALL_LIBREOFFICE=true`.
- **YouTube links:** YouTube often blocks downloads from cloud servers. Process videos on your own computer, or upload the MP4 file.
- **Sign-in shows an error on the deployed site:** in the Clerk dashboard check that the development instance allows the Render address, and that both Clerk key variables are set. Then redeploy (the browser key is built in at build time, so changing it needs a new deploy).
- **No sign-in at all (fallback):** set `DEMO_MODE=true` and build argument `VITE_DEMO_MODE=true`. Everyone then shares one demo user, so use it only for a quick demo.
