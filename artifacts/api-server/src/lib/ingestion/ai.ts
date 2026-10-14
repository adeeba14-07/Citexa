import { createHash } from "node:crypto";
import path from "node:path";
import OpenAI from "openai";
import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "@workspace/db";
import { aiCacheTable, unitsTable } from "@workspace/db/schema";

export const modelConfig = {
  structure: process.env.CITEXA_STRUCTURE_MODEL ?? "llama-3.3-70b-versatile",
  vision: process.env.CITEXA_VISION_MODEL ?? "qwen/qwen3.8-27b",
  tutor: process.env.CITEXA_TUTOR_MODEL ?? "llama-3.3-70b-versatile",
  assessment: process.env.CITEXA_ASSESSMENT_MODEL ?? "llama-3.3-70b-versatile",
  // Local feature-hash embeddings keep retrieval available without a paid embedding API.
  embedding: "citexa-local-hash-1536-v1",
  validator: process.env.CITEXA_VALIDATOR_MODEL ?? "llama-3.1-8b-instant",
  transcription: process.env.CITEXA_TRANSCRIPTION_MODEL ?? "whisper-large-v3",
};

let client: OpenAI | undefined;

/** OpenAI-compatible client configured to call Groq. Kept under the existing function
 * name so all existing call sites migrate without changing their business logic. */
export function openai(): OpenAI {
  if (client) return client;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("Groq is not configured. Add GROQ_API_KEY to your .env file.");
  }
  client = new OpenAI({ apiKey, baseURL: "https://api.groq.com/openai/v1" });
  hardenJsonCalls(client);
  return client;
}

/**
 * Deterministic local feature-hash embeddings. This avoids a paid embeddings API and
 * preserves the project's existing 1536-dimensional pgvector schema. Lexical retrieval
 * remains enabled alongside vectors; this is not a neural semantic embedding model.
 */
export function embedTexts(texts: string[]): number[][] {
  const dimensions = 1536;
  return texts.map((text) => {
    const vector = new Array<number>(dimensions).fill(0);
    const tokens = (text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12000);
    const features: string[] = [...tokens];
    for (let i = 0; i + 1 < tokens.length; i += 1) features.push(`${tokens[i]}_${tokens[i + 1]}`);
    for (const feature of features) {
      const digest = createHash("sha256").update(feature).digest();
      const index = digest.readUInt32BE(0) % dimensions;
      const sign = (digest[4] & 1) === 0 ? 1 : -1;
      vector[index] += sign;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm ? vector.map((value) => value / norm) : vector;
  });
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorStatus(error: unknown): number {
  return error && typeof error === "object" && "status" in error
    ? Number((error as { status?: unknown }).status)
    : 0;
}

/** Groq tells us how long to wait ("Please try again in 22.95s" / "in 1m3.2s"), or sends a retry-after header. */
function suggestedWaitMs(error: unknown): number | null {
  const headers =
    error && typeof error === "object" && "headers" in error
      ? ((error as { headers?: unknown }).headers as
          | { get?: (name: string) => string | null; [key: string]: unknown }
          | undefined)
      : undefined;
  let header: string | null | undefined;
  if (headers) {
    header =
      typeof headers.get === "function"
        ? headers.get("retry-after")
        : (headers["retry-after"] as string | undefined);
  }
  if (header && Number.isFinite(Number(header))) return Number(header) * 1000;
  const message = error instanceof Error ? error.message : String(error);
  const match = /try again in\s+(?:(\d+)m)?\s*([\d.]+)s/i.exec(message);
  if (match) return ((match[1] ? Number(match[1]) * 60 : 0) + Number(match[2])) * 1000;
  const ms = /try again in\s+([\d.]+)ms/i.exec(message);
  if (ms) return Number(ms[1]);
  return null;
}

export class RateLimitExhausted extends Error {}

/**
 * Retries transient failures. On a Groq 429 it waits exactly as long as Groq asks (plus a
 * small margin) instead of hammering the API, so free-tier token-per-minute limits are
 * respected rather than failing the whole source.
 */
export async function withRetry<T>(operation: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const status = errorStatus(error);
      const retryable =
        status === 0 || status === 408 || status === 409 || status === 429 || status >= 500;
      if (!retryable || attempt === maxAttempts - 1) break;
      const suggested = status === 429 ? suggestedWaitMs(error) : null;
      if (status === 429 && (suggested === null || suggested > 15_000 || attempt >= 1)) {
        // Do not make a student wait through long/repeated quota windows. AI-backed
        // routes can use cited source fallbacks; other routes return a short retry hint.
        throw new RateLimitExhausted(
          "The explanation service is temporarily busy. Please try again shortly; your course materials and saved study data are unchanged.",
        );
      }
      const wait =
        suggested !== null
          ? suggested + 750
          : Math.min(1000 * 2 ** attempt, 20_000) + Math.random() * 400;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastError;
}

/** Runs vision calls one at a time with a small gap so image tokens never burst past the per-minute limit. */
let visionChain: Promise<unknown> = Promise.resolve();
export function visionSlot<T>(task: () => Promise<T>): Promise<T> {
  const gap = Number(process.env.CITEXA_VISION_GAP_MS ?? 1500);
  const run = visionChain.then(task, task);
  visionChain = run.then(
    () => new Promise((resolve) => setTimeout(resolve, gap)),
    () => new Promise((resolve) => setTimeout(resolve, gap)),
  );
  return run;
}

/** After Groq says the vision quota is exhausted, skip vision calls for a while instead of retrying every frame/page. */
let visionBlockedUntil = 0;
export function visionAvailable(): boolean {
  return Date.now() >= visionBlockedUntil;
}
export function tripVisionBreaker(error: unknown, minutes = 10): void {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RateLimitExhausted || /rate limit|429|quota/i.test(message)) {
    visionBlockedUntil = Date.now() + minutes * 60_000;
  }
}

/** auto (default): only send pages that look like they contain figures. all: every page. off: never. */
export function visionMode(): "auto" | "all" | "off" {
  const value = (process.env.CITEXA_VISION_MODE ?? "auto").toLowerCase();
  return value === "all" || value === "off" ? value : "auto";
}

export async function cachedAI<T>(
  cacheKey: string,
  model: string,
  create: () => Promise<T>,
): Promise<T> {
  const [cached] = await db
    .select({ response: aiCacheTable.response })
    .from(aiCacheTable)
    .where(eq(aiCacheTable.cacheKey, cacheKey))
    .limit(1);
  if (cached) return cached.response as T;

  const response = await create();
  await db
    .insert(aiCacheTable)
    .values({ cacheKey, model, response })
    .onConflictDoUpdate({
      target: aiCacheTable.cacheKey,
      set: { model, response, createdAt: new Date() },
    });
  return response;
}

export async function mapLimit<T, R>(
  values: T[],
  limit: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function errorMessage(error: unknown): string {
  // Drizzle wraps Postgres errors as "Failed query: <huge SQL>"; the useful text is on .cause.
  let root: unknown = error;
  while (root instanceof Error && (root as { cause?: unknown }).cause instanceof Error) {
    root = (root as { cause?: unknown }).cause;
  }
  let message = root instanceof Error ? root.message : String(root);
  if (/^Failed query:/i.test(message) && error instanceof Error) {
    message = `Database write failed: ${error.message.slice(0, 120)}…`;
  }
  return message.replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted]").slice(0, 600);
}


type Role = "structure" | "tutor" | "assessment" | "validator" | "vision" | "transcription";

const NON_CHAT = /whisper|guard|tts|orpheus|playai|embed|distil-whisper/i;
const PREFERRED: Record<Role, string[]> = {
  structure: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "qwen/qwen3-32b", "openai/gpt-oss-20b", "llama-3.1-8b-instant"],
  tutor: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "qwen/qwen3-32b", "openai/gpt-oss-20b", "llama-3.1-8b-instant"],
  assessment: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "qwen/qwen3-32b", "openai/gpt-oss-20b", "llama-3.1-8b-instant"],
  // Validator should differ from the generator where possible (cross-model verification).
  validator: ["openai/gpt-oss-20b", "llama-3.1-8b-instant", "qwen/qwen3-32b", "openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
  vision: ["meta-llama/llama-4-scout-17b-16e-instruct", "meta-llama/llama-4-maverick-17b-128e-instruct"],
  transcription: ["whisper-large-v3-turbo", "whisper-large-v3"],
};

let modelsReady: Promise<void> | undefined;

/**
 * Checks which models your Groq account can actually use and swaps any unavailable
 * configured model for the best available one (logged). Never throws.
 */
export function ensureModels(): Promise<void> {
  modelsReady ??= (async () => {
    try {
      const list = await openai().models.list();
      const ids = list.data.map((m) => m.id);
      const chat = ids.filter((id) => !NON_CHAT.test(id));
      const log = (role: string, from: string, to: string) =>
        console.warn(`[models] "${from}" is not available on this Groq account; using "${to}" for ${role}.`);
      for (const role of Object.keys(PREFERRED) as Role[]) {
        const current = modelConfig[role];
        if (ids.includes(current)) continue;
        const pool = role === "transcription" ? ids.filter((id) => /whisper/i.test(id)) : role === "vision" ? ids : chat;
        const pick =
          PREFERRED[role].find((id) => ids.includes(id)) ??
          (role === "vision" || role === "transcription" ? undefined : pool[0]);
        if (pick) {
          log(role, current, pick);
          modelConfig[role] = pick;
        } else if (role !== "vision") {
          console.warn(`[models] No usable model found for ${role}. Available: ${ids.join(", ")}`);
        } else {
          console.warn(`[models] Vision model "${current}" unavailable; figure captioning will be skipped.`);
        }
      }
      console.log(`[models] in use: ${JSON.stringify({ ...modelConfig, embedding: undefined })}`);
    } catch (error) {
      modelsReady = undefined; // try again next time (e.g. key added later)
      console.warn(`[models] Could not list Groq models: ${errorMessage(error)}`);
    }
  })();
  return modelsReady;
}


/* ---------- Resilient JSON generation ---------- */

/** Pulls a JSON object out of model output: strips <think> blocks and code fences, repairs truncation. */
export function extractJson(raw: string): string | null {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "").trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  text = text.slice(start);
  const end = text.lastIndexOf("}");
  const candidates = end >= 0 ? [text.slice(0, end + 1)] : [];
  candidates.push(text);
  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      /* try repair */
    }
  }
  // Repair a truncated object: close any open string, brackets and braces.
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let repaired = text + (inString ? '"' : "");
  repaired = repaired.replace(/[,:\s]+$/, "");
  repaired += stack.reverse().join("");
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return null;
  }
}

function isReasoningModel(model: string): boolean {
  return /gpt-oss|qwen3|deepseek|r1|reasoning/i.test(model);
}

type AnyParams = Record<string, unknown> & {
  model?: string;
  response_format?: { type?: string };
  max_completion_tokens?: number;
  messages?: Array<{ role: string; content: unknown }>;
};

/** Explains what the model actually sent back, so a failure can be diagnosed from the source row. */
function noJsonMessage(model: string, response: any): string {
  const choice = response?.choices?.[0];
  const text = String(choice?.message?.content ?? "").replace(/\s+/g, " ").trim();
  const finish = choice?.finish_reason ? `, finish: ${choice.finish_reason}` : "";
  const preview = text ? `, started with: "${text.slice(0, 80)}"` : ", the reply was empty";
  return `Model returned no parseable JSON (${model}${finish}${preview}).`;
}

function withContent(response: any, content: string): any {
  const choice = response?.choices?.[0] ?? { index: 0, finish_reason: "stop" };
  return {
    ...response,
    choices: [{ ...choice, finish_reason: "stop", message: { ...(choice.message ?? { role: "assistant" }), content } }],
  };
}

/**
 * Wraps chat.completions.create so JSON-mode calls survive the common failures of newer Groq
 * models: reasoning text eating the token budget, "Failed to generate JSON" 400s, fenced output.
 */
function hardenJsonCalls(instance: OpenAI): void {
  const completions = instance.chat.completions as any;
  const original = completions.create.bind(completions);
  completions.create = async (params: AnyParams, options?: unknown) => {
    const isJson = params?.response_format?.type === "json_object" && !params.stream;
    if (!isJson) return original(params, options);

    const model = String(params.model ?? "");
    const first: AnyParams = { ...params };
    if (isReasoningModel(model)) {
      first.max_completion_tokens = Math.max(Number(params.max_completion_tokens ?? 1500) * 2, 3500);
      if (first.reasoning_effort === undefined) {
        if (/gpt-oss/i.test(model)) first.reasoning_effort = "low";
        else if (/qwen3/i.test(model)) first.reasoning_effort = "none";
      }
    }

    const finish = (response: any): any => {
      const content = response?.choices?.[0]?.message?.content;
      if (typeof content !== "string") return response;
      const json = extractJson(content);
      return json ? withContent(response, json) : response;
    };

    try {
      const response = await original(first, options);
      const json = extractJson(String(response?.choices?.[0]?.message?.content ?? ""));
      if (json) return withContent(response, json);
      throw Object.assign(new Error(noJsonMessage(model, response)), { status: 400 });
    } catch (error) {
      const status = errorStatus(error);
      if (status !== 400) throw error;
      const body = (error as { error?: any }).error;
      const failed: unknown = body?.failed_generation ?? body?.error?.failed_generation;
      if (typeof failed === "string") {
        const json = extractJson(failed);
        if (json) {
          return {
            id: "recovered",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: json } }],
          };
        }
      }
      // Last resort: plain text mode (no response_format / reasoning flags), more room, explicit instruction.
      const retry: AnyParams = { ...params };
      delete retry.response_format;
      retry.max_completion_tokens = Math.min(Math.max(Number(params.max_completion_tokens ?? 1500) * 2, 4000), 7000);
      const messages = [...(params.messages ?? [])];
      messages.push({ role: "user", content: "Reply with one valid JSON object only. No commentary, no markdown." });
      retry.messages = messages;
      const response = await original(retry, options);
      const out = finish(response);
      const json = extractJson(String(out?.choices?.[0]?.message?.content ?? ""));
      if (!json) throw error;
      return withContent(response, json);
    }
  };
}


/* ---------- Optional semantic (multilingual) embeddings ----------
 * OFF by default, so Citexa behaves exactly as before. To turn it on run `node enable-semantic.mjs`
 * (installs one extra package and sets CITEXA_EMBEDDINGS=semantic). A small neural model
 * (multilingual-e5-small, ~120 MB, runs locally through ONNX) then lets Hindi questions find
 * English sources. Vectors are zero-padded to the existing 1536-dimension column, so no database
 * migration is needed. If the model or package is missing, everything falls back to the old search.
 * The model loads in the background and never blocks the tutor or the server start.
 */
const SEMANTIC_MODEL = process.env.CITEXA_EMBED_MODEL ?? "Xenova/multilingual-e5-small";
const SEMANTIC_ENABLED = (process.env.CITEXA_EMBEDDINGS ?? "hash").toLowerCase() === "semantic";
const VECTOR_DIMENSIONS = 1536;

export function semanticEmbeddingName(): string {
  return `citexa-semantic:${SEMANTIC_MODEL}:q8:pad1536-v1`;
}
const reindexKey = () => `semantic-reindex:${semanticEmbeddingName()}`;

let semanticState: "off" | "loading" | "ready" | "failed" = SEMANTIC_ENABLED ? "loading" : "off";
let extractor: any;
let embeddingsInit: Promise<void> | undefined;

export function semanticActive(): boolean {
  return semanticState === "ready";
}

/** Minimum cosine similarity for a vector-only hit. e5 scores cluster high, so this is tunable. */
export function semanticMinSimilarity(): number {
  const value = Number(process.env.CITEXA_MIN_SIMILARITY ?? 0.72);
  return Number.isFinite(value) ? value : 0.72;
}

async function embedSemanticRaw(prefixed: string[]): Promise<number[][]> {
  const rows: number[][] = [];
  for (let start = 0; start < prefixed.length; start += 16) {
    const output = await extractor(prefixed.slice(start, start + 16), {
      pooling: "mean",
      normalize: true,
    });
    for (const row of output.tolist() as number[][]) {
      if (row.length > VECTOR_DIMENSIONS) throw new Error("Embedding model output is too large.");
      rows.push([...row, ...new Array<number>(VECTOR_DIMENSIONS - row.length).fill(0)]);
    }
  }
  return rows;
}

/** Starts loading the model in the background (idempotent). Resolves when loading has finished. Never throws. */
export function ensureEmbeddings(): Promise<void> {
  embeddingsInit ??= (async () => {
    if (!SEMANTIC_ENABLED) return;
    try {
      const moduleName: string = "@huggingface/transformers";
      const transformers: any = await import(moduleName);
      transformers.env.cacheDir = path.join(
        process.env.STORAGE_DIR ?? path.resolve(process.cwd(), ".local-storage"),
        "models",
      );
      let lastPercent = -10;
      console.log(`[embeddings] loading ${SEMANTIC_MODEL} (first run downloads about 120 MB)...`);
      extractor = await transformers.pipeline("feature-extraction", SEMANTIC_MODEL, {
        dtype: "q8",
        progress_callback: (info: any) => {
          if (info?.status === "progress" && typeof info.progress === "number" && info.progress - lastPercent >= 10) {
            lastPercent = info.progress;
            console.log(`[embeddings] downloading model: ${Math.round(info.progress)}%`);
          }
        },
      });
      const probe = await embedSemanticRaw(["passage: hello"]);
      if (probe[0]?.length !== VECTOR_DIMENSIONS) throw new Error("Unexpected embedding size.");
      semanticState = "ready";
      modelConfig.embedding = semanticEmbeddingName();
      console.log("[embeddings] multilingual semantic search is ON.");
      void reindexUnitsIfNeeded();
    } catch (error) {
      semanticState = "failed";
      console.warn(
        `[embeddings] Semantic model unavailable, using the standard search instead: ${errorMessage(error)}`,
      );
    }
  })();
  return embeddingsInit;
}

/** Embeds text with the semantic model when it is ready, otherwise with the hash embeddings. */
export async function embedForIndex(texts: string[], kind: "query" | "passage"): Promise<number[][]> {
  if (semanticActive()) {
    const prefix = /e5/i.test(SEMANTIC_MODEL) ? `${kind}: ` : "";
    return embedSemanticRaw(texts.map((text) => `${prefix}${text.slice(0, 2000)}`));
  }
  return embedTexts(texts);
}

let unitsSemanticCache: Promise<boolean> | undefined;
/**
 * Vector search is only meaningful when the query and stored unit vectors come from the same model.
 * Never waits for the model: while it is still loading the tutor uses keyword search only.
 */
export async function vectorSearchSafe(): Promise<boolean> {
  void ensureEmbeddings();
  if (semanticActive()) return true;
  if (semanticState === "loading") return false;
  unitsSemanticCache ??= db
    .select({ key: aiCacheTable.cacheKey })
    .from(aiCacheTable)
    .where(eq(aiCacheTable.cacheKey, reindexKey()))
    .limit(1)
    .then((rows) => rows.length > 0)
    .catch(() => false);
  return !(await unitsSemanticCache);
}

let reindexing = false;
/** One-time background pass that re-embeds units created before semantic search was switched on. */
async function reindexUnitsIfNeeded(): Promise<void> {
  if (reindexing) return;
  reindexing = true;
  try {
    const key = reindexKey();
    const [done] = await db
      .select({ key: aiCacheTable.cacheKey })
      .from(aiCacheTable)
      .where(eq(aiCacheTable.cacheKey, key))
      .limit(1);
    if (done) return;
    console.log("[embeddings] re-indexing existing study units for semantic search...");
    let lastId: string | null = null;
    let total = 0;
    for (;;) {
      const batch: Array<{ id: string; text: string; figureCaption: string | null }> = await db
        .select({ id: unitsTable.id, text: unitsTable.text, figureCaption: unitsTable.figureCaption })
        .from(unitsTable)
        .where(lastId ? and(gt(unitsTable.id, lastId)) : undefined)
        .orderBy(asc(unitsTable.id))
        .limit(32);
      if (!batch.length) break;
      const vectors = await embedForIndex(
        batch.map((unit) =>
          [unit.text, unit.figureCaption ? `Figure: ${unit.figureCaption}` : ""].filter(Boolean).join("\n"),
        ),
        "passage",
      );
      await Promise.all(
        batch.map((unit, index) =>
          db.update(unitsTable).set({ embedding: vectors[index]! }).where(eq(unitsTable.id, unit.id)),
        ),
      );
      total += batch.length;
      lastId = batch[batch.length - 1]!.id;
      if (total % 160 === 0) console.log(`[embeddings] re-indexed ${total} units...`);
    }
    await db
      .insert(aiCacheTable)
      .values({ cacheKey: key, model: semanticEmbeddingName(), response: { done: true, total } })
      .onConflictDoNothing();
    unitsSemanticCache = Promise.resolve(true);
    console.log(`[embeddings] re-index complete: ${total} units.`);
  } catch (error) {
    console.warn(`[embeddings] Re-index stopped (it will retry on next start): ${errorMessage(error)}`);
  } finally {
    reindexing = false;
  }
}
