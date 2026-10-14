# Citexa production image (used by Render). Local development does not use this file.
FROM node:22-bookworm-slim

ARG INSTALL_LIBREOFFICE=true
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 build-essential ca-certificates curl \
 && if [ "$INSTALL_LIBREOFFICE" = "true" ]; then apt-get install -y --no-install-recommends libreoffice-impress; fi \
 && rm -rf /var/lib/apt/lists/*

# uv runs the Python helpers (PDF/slide extraction, yt-dlp)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
RUN npm install -g pnpm

WORKDIR /app
COPY . .

# The project lists Windows-only build helpers; they cannot install on Linux, so drop them here.
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));for(const k of Object.keys(p.devDependencies||{})){if(/win32/.test(k))delete p.devDependencies[k];}fs.writeFileSync('package.json',JSON.stringify(p,null,2));"
RUN pnpm install --no-frozen-lockfile

# Web app: the Clerk publishable key is baked into the browser bundle at build time.
ARG VITE_CLERK_PUBLISHABLE_KEY=""
ARG VITE_DEMO_MODE="false"
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY \
    VITE_DEMO_MODE=$VITE_DEMO_MODE \
    BASE_PATH=/
RUN pnpm --filter @workspace/studygraph run build
RUN pnpm --filter @workspace/api-server run build
RUN uv sync

ENV NODE_ENV=production \
    SERVE_WEB_DIR=/app/artifacts/studygraph/dist/public \
    STORAGE_DIR=/var/data \
    TRUST_PROXY=1
RUN mkdir -p /var/data

WORKDIR /app/artifacts/api-server
CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
