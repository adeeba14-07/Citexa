#!/usr/bin/env node
/**
 * One-command local runner for Citexa.
 *   pnpm run setup   -> enables pgvector and creates/updates the tables
 *   pnpm run dev     -> starts the API (3001) and the web app (5173)
 * Reads settings from ./.env (see .env.example). No extra dependencies.
 */
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { existsSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || line.trim().startsWith("#")) continue;
    let value = match[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}
loadEnv(path.join(root, ".env"));

// Windows: winget installs ffmpeg but a terminal opened earlier may not see it. Find it and add it to PATH.
function findFfmpegDir() {
  if (!isWindows) return null;
  const local = process.env.LOCALAPPDATA ?? "";
  const roots = [
    path.join(local, "Microsoft", "WinGet", "Packages"),
    path.join(local, "Microsoft", "WinGet", "Links"),
    "C:\\ffmpeg\\bin",
    "C:\\Program Files\\ffmpeg\\bin",
    "C:\\ProgramData\\chocolatey\\bin",
  ];
  const hasBoth = (dir) => existsSync(path.join(dir, "ffmpeg.exe")) && existsSync(path.join(dir, "ffprobe.exe"));
  const walk = (dir, depth) => {
    if (depth < 0 || !existsSync(dir)) return null;
    if (hasBoth(dir)) return dir;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const found = walk(path.join(dir, entry.name), depth - 1);
        if (found) return found;
      }
    }
    return null;
  };
  for (const root of roots) {
    const found = walk(root, 4);
    if (found) return found;
  }
  return null;
}
if (spawnSync("ffprobe", ["-version"], { shell: isWindows, stdio: "ignore" }).status !== 0) {
  const dir = findFfmpegDir();
  if (dir) {
    process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
    console.log(`  ffmpeg found at ${dir}`);
  }
}

const apiPort = process.env.API_PORT ?? "3001";
const webPort = process.env.WEB_PORT ?? "5173";
const useClerk = Boolean(process.env.CLERK_SECRET_KEY && process.env.CLERK_PUBLISHABLE_KEY);
const demo = process.env.DEMO_MODE ? process.env.DEMO_MODE === "true" : !useClerk;

const shared = {
  ...process.env,
  STORAGE_DIR: process.env.STORAGE_DIR ?? path.join(root, ".local-storage"),
  DEMO_MODE: String(demo),
  VITE_DEMO_MODE: String(demo),
  API_PORT: apiPort,
};
if (!demo && process.env.CLERK_PUBLISHABLE_KEY && !process.env.VITE_CLERK_PUBLISHABLE_KEY) {
  shared.VITE_CLERK_PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY;
}
mkdirSync(shared.STORAGE_DIR, { recursive: true });

function run(command, args, options = {}) {
  return spawn(command, args, { cwd: root, env: shared, shell: isWindows, stdio: ["ignore", "pipe", "pipe"], ...options });
}

function pipeWithPrefix(child, prefix) {
  const write = (stream) => (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim()) stream.write(`[${prefix}] ${line}\n`);
    }
  };
  child.stdout.on("data", write(process.stdout));
  child.stderr.on("data", write(process.stderr));
}

function check(command, args, label, hint) {
  const result = spawnSync(command, args, { shell: isWindows, stdio: "ignore" });
  if (result.status !== 0) console.warn(`  ! ${label} not found. ${hint}`);
}

if (!shared.DATABASE_URL) {
  console.error("DATABASE_URL is missing. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

if (process.argv.includes("--setup")) {
  console.log("Enabling pgvector and creating tables…");
  for (const args of [["--filter", "@workspace/db", "run", "setup"], ["--filter", "@workspace/db", "run", "push"]]) {
    const result = spawnSync("pnpm", args, { cwd: root, env: shared, shell: isWindows, stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  console.log("\nDatabase is ready. Start the app with: pnpm run dev");
  process.exit(0);
}

console.log("Citexa local runner");
console.log(`  mode: ${demo ? "DEMO (no sign-in needed)" : "Clerk sign-in"}`);
if (!shared.GROQ_API_KEY) console.warn("  ! GROQ_API_KEY is not set. AI features need it.");
check("uv", ["--version"], "uv", "Install from https://docs.astral.sh/uv/ (needed for PDF/PPTX extraction).");
check("ffmpeg", ["-version"], "ffmpeg", "Install ffmpeg (needed for video processing).");
check(isWindows ? "soffice" : "soffice", ["--version"], "LibreOffice", "Install LibreOffice to render PPTX slide images (PDF slides still work).");

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ port, host: "127.0.0.1" });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false); else setTimeout(attempt, 1000);
      });
    };
    attempt();
  });
}

const api = run("pnpm", ["--filter", "@workspace/api-server", "run", "dev"], { env: { ...shared, PORT: apiPort, NODE_ENV: "development" } });
const web = run("pnpm", ["--filter", "@workspace/studygraph", "run", "dev"], { env: { ...shared, PORT: webPort, BASE_PATH: "/" } });
pipeWithPrefix(api, "api");
pipeWithPrefix(web, "web");
console.log("\n  Starting the API (first build takes up to a minute)...");
waitForPort(Number(apiPort), 240_000).then((ok) => {
  console.log(ok
    ? `\n  \u2714 API is ready. Open http://localhost:${webPort}\n  (Any "proxy error ECONNREFUSED" lines above appeared only while the API was still building.)\n`
    : `\n  ! The API did not start within 4 minutes. Scroll up for the [api] error.\n`);
});

function stop() {
  for (const child of [api, web]) {
    try {
      // On Windows child.kill() leaves the node/vite grandchildren running; kill the whole tree.
      if (isWindows && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill();
    } catch { /* already stopped */ }
  }
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
api.on("exit", (code) => { if (code) { console.error(`API exited with code ${code}.`); stop(); } });
web.on("exit", (code) => { if (code) { console.error(`Web app exited with code ${code}.`); stop(); } });
