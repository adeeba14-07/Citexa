// Optional: turns on multilingual semantic search (Hindi question -> English source).
// Run from the project folder:  node enable-semantic.mjs
// Safe to run more than once. To turn it off later, set CITEXA_EMBEDDINGS=hash in .env.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const say = (message) => console.log(`  ${message}`);

console.log("\nCitexa: enabling multilingual semantic search\n");

// 1) Let pnpm run the install scripts of the packages the embedding model needs.
const workspaceFile = path.join(root, "pnpm-workspace.yaml");
if (existsSync(workspaceFile)) {
  let text = readFileSync(workspaceFile, "utf8");
  const needed = ["onnxruntime-node", "sharp", "protobufjs"].filter((name) => !new RegExp(`^\\s+${name}:`, "m").test(text));
  if (needed.length) {
    copyFileSync(workspaceFile, `${workspaceFile}.bak`);
    const lines = needed.map((name) => `  ${name}: true`).join("\n");
    text = /^allowBuilds:/m.test(text)
      ? text.replace(/^allowBuilds:\s*\n/m, (match) => `${match}${lines}\n`)
      : `${text.trimEnd()}\n\nallowBuilds:\n${lines}\n`;
    writeFileSync(workspaceFile, text);
    say("Updated pnpm-workspace.yaml (backup saved as pnpm-workspace.yaml.bak).");
  }
}

// 2) Install the one extra package.
say("Installing @huggingface/transformers (this can take a minute)...");
spawnSync("pnpm", ["--filter", "@workspace/api-server", "add", "@huggingface/transformers@^3.5.0"], {
  cwd: root,
  shell: isWindows,
  stdio: "inherit",
});
const installed = existsSync(path.join(root, "artifacts", "api-server", "node_modules", "@huggingface", "transformers", "package.json"));
if (!installed) {
  console.error("\n  The package did not install. Citexa still works normally (standard search).");
  console.error("  Scroll up for the pnpm error, or run: pnpm approve-builds   then run this script again.\n");
  process.exit(1);
}

// 3) Switch it on in .env (only adds a line; never rewrites your other settings).
const envFile = path.join(root, ".env");
if (existsSync(envFile)) {
  const env = readFileSync(envFile, "utf8");
  if (!/^\s*CITEXA_EMBEDDINGS\s*=/m.test(env)) {
    appendFileSync(envFile, `${env.endsWith("\n") ? "" : "\n"}\n# Multilingual semantic search (set to hash to turn off)\nCITEXA_EMBEDDINGS=semantic\n`);
    say("Added CITEXA_EMBEDDINGS=semantic to .env.");
  } else {
    say("CITEXA_EMBEDDINGS is already set in .env. Make sure it says: CITEXA_EMBEDDINGS=semantic");
  }
} else {
  say("No .env found. Add this line to your .env:  CITEXA_EMBEDDINGS=semantic");
}

console.log("\n  Done. Now restart:  pnpm run dev");
console.log("  First start downloads the model (about 120 MB) and re-indexes your sources in the background.");
console.log("  Watch the API terminal for lines starting with [embeddings].\n");
