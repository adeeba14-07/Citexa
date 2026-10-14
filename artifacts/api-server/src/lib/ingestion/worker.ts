import { createWriteStream } from "node:fs";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  conceptEdgesTable,
  conceptsTable,
  aiCacheTable,
  ingestionJobsTable,
  sourcesTable,
  topicsTable,
  unitConceptsTable,
  unitsTable,
  type SourceLocator,
} from "@workspace/db/schema";
import { ObjectStorageService } from "../objectStorage";
import {
  cachedAI,
  errorMessage,
  embedForIndex,
  ensureEmbeddings,
  mapLimit,
  modelConfig,
  openai,
  ensureModels,
  RateLimitExhausted,
  sha256,
  tripVisionBreaker,
  visionAvailable,
  visionMode,
  visionSlot,
  withRetry,
} from "./ai";
import { logger } from "../logger";

const storage = new ObjectStorageService();
const MAX_VIDEO_SECONDS = 2 * 60 * 60;
const MAX_CAPTION_VIDEO_SECONDS = 6 * 60 * 60;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const VIDEO_FRAME_INTERVAL_SEC = 90;
const MAX_VIDEO_FRAMES = 80;

type DocumentPage = {
  number: number;
  text: string;
  image: string;
  visionImage?: string | null;
  hasVisual?: boolean;
  type: "page" | "slide";
};

type UnitDraft = {
  text: string;
  figureCaption: string | null;
  locator: SourceLocator;
  language: string;
};

type VisualDescription = {
  hasMeaningfulVisual: boolean;
  caption: string | null;
  ocrText: string | null;
};

type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

type Taxonomy = {
  topics: Array<{
    name: string;
    description: string;
    concepts: Array<{
      name: string;
      description: string;
      unitIndexes: number[];
      prerequisiteNames: string[];
    }>;
  }>;
};

function sourceError(error: unknown): string {
  const message = errorMessage(error).trim();
  return message.slice(0, 1200) || "Source processing failed.";
}

async function setProgress(
  sourceId: string,
  status: "queued" | "processing" | "ready" | "failed",
  progress: number,
  currentStep: string | null,
  error: string | null = null,
  unitsCreated?: number,
): Promise<void> {
  assertNotCancelled(sourceId);
  const updatedAt = new Date();
  const values = {
    status,
    progress: Math.max(0, Math.min(100, Math.round(progress))),
    currentStep,
    error,
    updatedAt,
    ...(unitsCreated === undefined ? {} : { unitsCreated }),
  };
  await Promise.all([
    db.update(sourcesTable).set(values).where(eq(sourcesTable.id, sourceId)),
    db
      .update(ingestionJobsTable)
      .set(values)
      .where(eq(ingestionJobsTable.id, sourceId)),
  ]);
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; maxOutput?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const process = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputSize = 0;
    const maxOutput = options.maxOutput ?? 2 * 1024 * 1024;

    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > maxOutput) {
        process.kill("SIGKILL");
        rejectPromise(new Error(`${command} produced too much output.`));
        return;
      }
      target.push(chunk);
    };
    process.stdout.on("data", collect(stdout));
    process.stderr.on("data", collect(stderr));
    process.on("error", (error) => {
      rejectPromise(
        new Error(
          `Could not start ${command}. Install the required system tool and try again: ${error.message}`,
        ),
      );
    });
    process.on("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) {
        resolvePromise(result);
      } else {
        const detail = (result.stderr || result.stdout).trim().slice(-1600);
        rejectPromise(
          new Error(`${command} exited with code ${code ?? "unknown"}: ${detail}`),
        );
      }
    });
  });
}

/**
 * YouTube sources: read the video's own captions instead of downloading the video. This is faster,
 * needs no ffmpeg or speech-to-text quota, is not blocked as often as downloads, and has no 2-hour
 * limit. Each unit keeps its start/end time, so citations still jump to the right moment.
 */
async function processYoutubeCaptions(
  source: typeof sourcesTable.$inferSelect,
  workDir: string,
): Promise<UnitDraft[]> {
  if (!source.sourceUrl) throw new Error("No YouTube address.");
  const root = resolve(process.cwd(), "../..");
  const wanted = source.language && source.language !== "auto" ? source.language.toLowerCase() : "auto";
  const languageOrder = wanted === "auto"
    ? ["en", "hi", "ta", "te", "bn", "mr"]
    : [wanted, ...["en", "hi", "ta", "te", "bn", "mr"].filter((language) => language !== wanted)];
  const langs = [...new Set(languageOrder.flatMap((language) => [`${language}.*`, language]))].join(",");
  await runCommand(
    "uv",
    [
      "run",
      "--project",
      root,
      "python",
      "-m",
      "yt_dlp",
      "--no-playlist",
      "--js-runtimes",
      "node",
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      langs,
      "--sub-format",
      "json3",
      "--retries",
      "2",
      "--extractor-retries",
      "1",
      "--socket-timeout",
      "20",
      ...(process.env.YTDLP_COOKIES_FILE
        ? ["--cookies", process.env.YTDLP_COOKIES_FILE]
        : process.env.YTDLP_COOKIES_BROWSER
          ? ["--cookies-from-browser", process.env.YTDLP_COOKIES_BROWSER]
          : []),
      "--output",
      join(workDir, "captions.%(ext)s"),
      "--",
      source.sourceUrl,
    ],
    { cwd: root, maxOutput: 4 * 1024 * 1024 },
  );
  const { readdir, readFile } = await import("node:fs/promises");
  const files = (await readdir(workDir)).filter((name) => /^captions\..+\.json3$/.test(name));
  if (!files.length) throw new Error("This video has no captions.");
  // Prefer the requested language, then English, then whatever exists.
  const rank = (name: string) => {
    const lang = name.replace(/^captions\./, "").replace(/\.json3$/, "").toLowerCase();
    const index = languageOrder.findIndex((language) => lang === language || lang.startsWith(`${language}.`));
    return index < 0 ? languageOrder.length : index;
  };
  const chosen = [...files].sort((a, b) => rank(a) - rank(b))[0]!;
  const parsed = JSON.parse(await readFile(join(workDir, chosen), "utf8")) as {
    events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }>;
  };
  const lines: TranscriptSegment[] = [];
  for (const event of parsed.events ?? []) {
    if (!event.segs) continue;
    const text = event.segs
      .map((segment) => segment.utf8 ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || /^\[[^\]]*\]$/.test(text) || /^\(.*\)$/.test(text)) continue;
    const start = Math.max(0, (event.tStartMs ?? 0) / 1000);
    lines.push({ start, end: start + Math.max(0.5, (event.dDurationMs ?? 2000) / 1000), text });
  }
  if (!lines.length) throw new Error("The captions were empty.");
  const total = lines[lines.length - 1]!.end;
  if (total > MAX_CAPTION_VIDEO_SECONDS) {
    throw new Error("Videos longer than six hours are not supported.");
  }
  // Group caption lines into readable windows (about 45 seconds or 700 characters).
  const language = chosen.replace(/^captions\./, "").replace(/\.json3$/, "");
  const drafts: UnitDraft[] = [];
  let group: TranscriptSegment[] = [];
  const flush = () => {
    if (!group.length) return;
    drafts.push({
      text: group.map((item) => item.text).join(" "),
      figureCaption: null,
      locator: { type: "video", start_sec: group[0]!.start, end_sec: group[group.length - 1]!.end },
      language: source.language && source.language !== "auto" ? source.language : language,
    });
    group = [];
  };
  for (const line of lines) {
    const length = group.reduce((sum, item) => sum + item.text.length + 1, 0);
    if (group.length && (line.end - group[0]!.start > 45 || length + line.text.length > 700)) flush();
    group.push(line);
  }
  flush();
  return drafts;
}

async function downloadSource(source: typeof sourcesTable.$inferSelect, workDir: string) {
  if (source.sourceType === "video" && source.sourceUrl) {
    const root = resolve(process.cwd(), "../..");
    const target = join(workDir, "video.%(ext)s");
    await runCommand(
      "uv",
      [
        "run",
        "--project",
        root,
        "python",
        "-m",
        "yt_dlp",
        "--no-playlist",
        // yt-dlp needs a JavaScript runtime to solve YouTube's challenges; Node is already installed.
        "--js-runtimes",
        "node",
        "--format",
        "bestaudio/best",
        "--no-progress",
        "--retries",
        "2",
        "--fragment-retries",
        "2",
        "--extractor-retries",
        "1",
        "--socket-timeout",
        "20",
        ...(process.env.YTDLP_COOKIES_FILE
          ? ["--cookies", process.env.YTDLP_COOKIES_FILE]
          : process.env.YTDLP_COOKIES_BROWSER
            ? ["--cookies-from-browser", process.env.YTDLP_COOKIES_BROWSER]
            : []),
        "--max-filesize",
        `${Math.floor(MAX_VIDEO_BYTES / (1024 * 1024))}M`,
        "--output",
        target,
        "--",
        source.sourceUrl,
      ],
      { cwd: root, maxOutput: 8 * 1024 * 1024 },
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/403|Forbidden|Sign in to confirm|not a bot/i.test(message)) {
        throw new Error(
          "YouTube blocked both the captions and the video download for this link (403). This happens on cloud servers or after many requests. Try again later, run Citexa on your own computer (optionally with YTDLP_COOKIES_BROWSER=chrome in .env), or download the video and upload the MP4 file instead.",
        );
      }
      throw error;
    });
    const files = (await readdir(workDir)).filter(
      (name) => name.startsWith("video.") && !name.endsWith(".part"),
    );
    const video = files.find((name) => extname(name).toLowerCase() !== ".description");
    if (!video) throw new Error("YouTube did not provide a downloadable audio/video stream.");
    return join(workDir, video);
  }

  if (!source.storagePath) {
    throw new Error("The uploaded source has no storage path.");
  }
  const file = await storage.getObjectEntityFile(source.storagePath);
  const [metadata] = await file.getMetadata();
  const actualSize = Number(metadata.size ?? 0);
  if (actualSize < 1) throw new Error("The uploaded file is empty.");
  if (actualSize > MAX_VIDEO_BYTES && source.sourceType === "video") {
    throw new Error("Video files larger than 500 MB cannot be processed.");
  }
  const extension = extname(source.originalFilename ?? "") || ".bin";
  const target = join(workDir, `source${extension}`);
  await pipeline(file.createReadStream(), createWriteStream(target));
  return target;
}

function splitText(text: string, maxLength = 1400): string[] {
  const normalized = text.replace(/\r/g, "").trim();
  if (normalized.length <= maxLength) return normalized ? [normalized] : [];
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxLength) {
    let boundary = remaining.lastIndexOf("\n\n", maxLength);
    if (boundary < maxLength * 0.55) boundary = remaining.lastIndexOf(" ", maxLength);
    if (boundary < maxLength * 0.55) boundary = maxLength;
    chunks.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

const EMPTY_VISUAL: VisualDescription = { hasMeaningfulVisual: false, caption: null, ocrText: null };

async function describeImage(
  page: DocumentPage,
): Promise<VisualDescription> {
  const mode = visionMode();
  if (mode === "off" || !visionAvailable()) return EMPTY_VISUAL;
  // In auto mode, text-only pages never touch the vision model (saves tokens and time).
  if (mode === "auto" && page.hasVisual === false) return EMPTY_VISUAL;
  const imagePath = page.visionImage ?? page.image;
  const mime = imagePath.endsWith(".jpg") ? "image/jpeg" : "image/png";
  const extractedText = page.text;
  const image = await readFile(imagePath);
  const cacheMaterial = Buffer.concat([
    image,
    Buffer.from(`\n${extractedText.slice(0, 3000)}`),
  ]);
  const key = `vision-v3:${modelConfig.vision}:${sha256(cacheMaterial)}`;
  try {
    return await cachedAI<VisualDescription>(key, modelConfig.vision, async () => {
      const completion = await visionSlot(() =>
        withRetry(() =>
          openai().chat.completions.create({
            model: modelConfig.vision,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content:
                  "Read a lecture page faithfully. Extract only clearly legible printed text visible in the image that is not already present in the supplied text layer; preserve wording, numbers, and equations, and do not guess obscured text. Describe meaningful diagrams, charts, equations, tables, or instructional images in a concise caption, in the material's language where clear. Never infer facts. Always return all JSON fields: {\"hasMeaningfulVisual\":false,\"caption\":null,\"ocrText\":null} when no visual or extra readable text is present; otherwise set the applicable caption and/or ocrText and set other fields to null.",
              },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `Extract source text and figure details from this page. Existing selectable text (do not repeat it):\n${extractedText.slice(0, 3000) || "(none; OCR visible text from the image)"}`,
                  },
                  {
                    type: "image_url",
                    image_url: { url: `data:${mime};base64,${image.toString("base64")}` },
                  },
                ],
              },
            ],
            max_completion_tokens: 900,
          }),
        ),
      );
      const content = completion.choices[0]?.message.content;
      if (!content) throw new Error("The vision model returned an empty response.");
      const parsed = JSON.parse(content) as Partial<VisualDescription>;
      const hasVisual = parsed.hasMeaningfulVisual === true;
      const caption =
        hasVisual && typeof parsed.caption === "string" ? parsed.caption.trim().slice(0, 1800) : null;
      return {
        hasMeaningfulVisual: hasVisual,
        caption,
        ocrText:
          typeof parsed.ocrText === "string" ? parsed.ocrText.trim().slice(0, 12000) || null : null,
      };
    });
  } catch (error) {
    tripVisionBreaker(error);
    // Figure captioning is an enhancement: if the vision model is unavailable or rate-limited,
    // keep the page's own extracted text instead of failing the whole source.
    logger.warn(
      { page: page.number, error: errorMessage(error) },
      "Vision captioning skipped for page; using extracted text only",
    );
    return EMPTY_VISUAL;
  }
}

function addDocumentPageUnits(
  page: DocumentPage,
  caption: string | null,
  ocrText: string | null,
  imagePath: string | undefined,
  language: string,
): UnitDraft[] {
  const locator: SourceLocator =
    page.type === "slide"
      ? { type: "slide", slide: page.number, ...(imagePath ? { imagePath } : {}) }
      : { type: "page", page: page.number, ...(imagePath ? { imagePath } : {}) };
  const chunks = splitText(
    [page.text, ocrText].filter((text): text is string => Boolean(text)).join("\n\n"),
  );
  if (!chunks.length && caption) chunks.push(caption);
  if (!chunks.length) return [];
  return chunks.map((text, index) => ({
    text,
    figureCaption: index === 0 ? caption : null,
    locator,
    language,
  }));
}

async function processDocument(
  source: typeof sourcesTable.$inferSelect,
  inputPath: string,
  workDir: string,
): Promise<UnitDraft[]> {
  const root = resolve(process.cwd(), "../..");
  const scriptPath = resolve(
    process.cwd(),
    "src/lib/ingestion/extract.py",
  );
  const renderDir = join(workDir, "rendered");
  await runCommand(
    "uv",
    [
      "run",
      "--project",
      root,
      "python",
      scriptPath,
      source.sourceType,
      inputPath,
      renderDir,
    ],
    { cwd: root, maxOutput: 4 * 1024 * 1024 },
  );
  const manifest = JSON.parse(
    await readFile(join(renderDir, "manifest.json"), "utf8"),
  ) as { pages: DocumentPage[] };
  if (!Array.isArray(manifest.pages) || manifest.pages.length === 0) {
    throw new Error("No pages or slides could be extracted from this file.");
  }

  await setProgress(
    source.id,
    "processing",
    34,
    `Describing figures and rendering source pages (0/${manifest.pages.length})`,
  );
  let completed = 0;
  let progressWrites = Promise.resolve();
  const drafts = await mapLimit(manifest.pages, 4, async (page) => {
    const description = await describeImage(page);
    const caption = description.caption;
    const ocrText = description.ocrText;
    let imagePath: string | undefined;
    if (page.text.trim() || ocrText || caption) {
      imagePath = await storage.saveDerivedObject({
        sourceId: source.id,
        fileName: `${page.type}-${String(page.number).padStart(4, "0")}.png`,
        contentType: "image/png",
        bytes: await readFile(page.image),
        ownerId: source.ownerId,
      });
    }
    completed += 1;
    const current = completed;
    progressWrites = progressWrites.then(() =>
      setProgress(
        source.id,
        "processing",
        34 + (current / manifest.pages.length) * 24,
        `Describing figures and rendering source pages (${current}/${manifest.pages.length})`,
      ),
    );
    await progressWrites;
    return addDocumentPageUnits(
      page,
      caption,
      ocrText,
      imagePath,
      source.language,
    );
  });
  return drafts.flat();
}

async function getVideoDuration(videoPath: string): Promise<number> {
  const result = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    videoPath,
  ]);
  const parsed = JSON.parse(result.stdout) as { format?: { duration?: string } };
  const duration = Number(parsed.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("The video duration could not be read.");
  }
  if (duration > MAX_VIDEO_SECONDS) {
    throw new Error("Videos longer than two hours are not supported.");
  }
  return duration;
}

async function hasAudioStream(videoPath: string): Promise<boolean> {
  const result = await runCommand("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a",
    "-show_entries",
    "stream=index",
    "-of",
    "json",
    videoPath,
  ]);
  const parsed = JSON.parse(result.stdout) as { streams?: unknown[] };
  return Boolean(parsed.streams?.length);
}

async function hasVideoStream(videoPath: string): Promise<boolean> {
  const result = await runCommand("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=index",
    "-of",
    "json",
    videoPath,
  ]);
  const parsed = JSON.parse(result.stdout) as { streams?: unknown[] };
  return Boolean(parsed.streams?.length);
}

async function transcribeAudio(
  videoPath: string,
  duration: number,
  workDir: string,
  language: string,
): Promise<TranscriptSegment[]> {
  const audioDir = join(workDir, "audio");
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(audioDir, { recursive: true }),
  );
  await runCommand("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    videoPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "segment",
    "-segment_time",
    "600",
    "-reset_timestamps",
    "1",
    "-segment_format",
    "wav",
    join(audioDir, "chunk-%03d.wav"),
  ]);
  const chunks = (await readdir(audioDir))
    .filter((name) => name.endsWith(".wav"))
    .sort();
  if (!chunks.length) throw new Error("No audio could be extracted from this video.");

  const segments = await mapLimit(chunks, 2, async (name, index) => {
    const chunkPath = join(audioDir, name);
    const offset = index * 600;
    const transcription = await withRetry(() =>
      openai().audio.transcriptions.create({
        file: createReadStream(chunkPath),
        model: modelConfig.transcription,
        response_format: "verbose_json",
        timestamp_granularities: ["segment"],
        ...(language && language !== "auto" ? { language } : {}),
      }),
    );
    const result = transcription as {
      text?: string;
      segments?: Array<{ start: number; end: number; text: string }>;
    };
    if (Array.isArray(result.segments) && result.segments.length) {
      return result.segments
        .filter((segment) => segment.text.trim())
        .map((segment) => ({
          start: offset + Math.max(0, segment.start),
          end: Math.min(duration, offset + Math.max(segment.end, segment.start + 0.1)),
          text: segment.text.trim(),
        }));
    }
    if (result.text?.trim()) {
      return [
        {
          start: offset,
          end: Math.min(duration, offset + 600),
          text: result.text.trim(),
        },
      ];
    }
    return [];
  });
  return segments.flat().sort((a, b) => a.start - b.start);
}

async function processVideo(
  source: typeof sourcesTable.$inferSelect,
  videoPath: string,
  workDir: string,
): Promise<UnitDraft[]> {
  const duration = await getVideoDuration(videoPath);
  let transcript: TranscriptSegment[] = [];
  if (await hasAudioStream(videoPath)) {
    await setProgress(source.id, "processing", 30, "Transcribing video audio");
    transcript = await transcribeAudio(videoPath, duration, workDir, source.language);
  }

  const framesDir = join(workDir, "frames");
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(framesDir, { recursive: true }),
  );
  if (await hasVideoStream(videoPath)) {
    await setProgress(source.id, "processing", 50, "Sampling representative video frames");
    await runCommand(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        videoPath,
        "-vf",
        `fps=1/${VIDEO_FRAME_INTERVAL_SEC},scale='min(1280,iw)':-2`,
        "-frames:v",
        String(MAX_VIDEO_FRAMES),
        "-q:v",
        "3",
        join(framesDir, "frame-%04d.jpg"),
      ],
      { maxOutput: 1024 * 1024 },
    );
  } else {
    await setProgress(source.id, "processing", 50, "Audio-only source; skipping frame analysis");
  }
  const frameFiles = (await readdir(framesDir))
    .filter((name) => name.endsWith(".jpg"))
    .sort();
  const frameDescriptions = await mapLimit(frameFiles, 4, async (name, index) => {
    const framePath = join(framesDir, name);
    const bytes = await readFile(framePath);
    const timeSec = Math.min(duration, index * VIDEO_FRAME_INTERVAL_SEC);
    const key = `video-vision-v3:${modelConfig.vision}:${sha256(bytes)}`;
    let description: VisualDescription = EMPTY_VISUAL;
    if (visionMode() === "all" && visionAvailable()) try {
      description = await cachedAI<VisualDescription>(
      key,
      modelConfig.vision,
      async () => {
        const completion = await visionSlot(() => withRetry(() =>
          openai().chat.completions.create({
            model: modelConfig.vision,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content:
                  "Describe meaningful instructional visuals in the material's language where clear. Transcribe only clearly readable instructional on-screen text, preserving wording, numbers, and equations. Do not infer or invent speech or events. Always return all JSON fields: {\"hasMeaningfulVisual\":false,\"caption\":null,\"ocrText\":null} when there is no useful visual or readable on-screen text; otherwise set the applicable caption and/or ocrText and set other fields to null.",
              },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `This is a sampled frame at ${timeSec} seconds. Caption only what is visibly present.`,
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:image/jpeg;base64,${bytes.toString("base64")}`,
                    },
                  },
                ],
              },
            ],
            max_completion_tokens: 700,
          }),
        ));
        const content = completion.choices[0]?.message.content;
        if (!content) throw new Error("The vision model returned an empty response.");
        const parsed = JSON.parse(content) as Partial<VisualDescription>;
        if (
          typeof parsed.hasMeaningfulVisual !== "boolean" ||
          (parsed.caption !== null && typeof parsed.caption !== "string") ||
          (parsed.ocrText !== null && typeof parsed.ocrText !== "string")
        ) {
          throw new Error("The vision model returned an invalid frame OCR/caption.");
        }
        return {
          hasMeaningfulVisual: parsed.hasMeaningfulVisual,
          caption:
            parsed.hasMeaningfulVisual && typeof parsed.caption === "string"
              ? parsed.caption.trim().slice(0, 1800)
              : null,
          ocrText:
            typeof parsed.ocrText === "string"
              ? parsed.ocrText.trim().slice(0, 6000) || null
              : null,
        };
      },
    );
    } catch (error) {
      tripVisionBreaker(error);
      logger.warn(
        { timeSec, error: errorMessage(error) },
        "Frame captioning skipped; keeping the transcript for this moment",
      );
    }
    return {
      timeSec,
      framePath,
      bytes,
      caption: description.caption,
      ocrText: description.ocrText,
    };
  });

  const imagePaths = await Promise.all(
    frameDescriptions.map(async (frame, index) => {
      if (!frame.caption && !frame.ocrText) return undefined;
      return storage.saveDerivedObject({
        sourceId: source.id,
        fileName: `frame-${String(index + 1).padStart(4, "0")}.jpg`,
        contentType: "image/jpeg",
        bytes: frame.bytes,
        ownerId: source.ownerId,
      });
    }),
  );

  const assignedFrames = new Set<number>();
  const drafts: UnitDraft[] = transcript.map((segment) => {
    const midpoint = (segment.start + segment.end) / 2;
    let closest = -1;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < frameDescriptions.length; index += 1) {
      const distance = Math.abs(frameDescriptions[index].timeSec - midpoint);
      if (distance <= VIDEO_FRAME_INTERVAL_SEC / 2 && distance < closestDistance) {
        closest = index;
        closestDistance = distance;
      }
    }
    const caption = closest >= 0 ? frameDescriptions[closest].caption : null;
    const ocrText = closest >= 0 ? frameDescriptions[closest].ocrText : null;
    const imagePath = closest >= 0 ? imagePaths[closest] : undefined;
    if (closest >= 0 && (caption || ocrText)) assignedFrames.add(closest);
    return {
      text: [segment.text, ocrText ? `On-screen text: ${ocrText}` : ""]
        .filter(Boolean)
        .join("\n\n"),
      figureCaption: caption ?? null,
      locator: {
        type: "video",
        start_sec: segment.start,
        end_sec: segment.end,
        ...(imagePath ? { imagePath } : {}),
      },
      language: source.language,
    };
  });

  frameDescriptions.forEach((frame, index) => {
    if ((!frame.caption && !frame.ocrText) || assignedFrames.has(index)) return;
    const start = frame.timeSec;
    const frameText = [
      frame.caption ? `Visual scene: ${frame.caption}` : "",
      frame.ocrText ? `On-screen text: ${frame.ocrText}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    drafts.push({
      text: frameText,
      figureCaption: frame.caption,
      locator: {
        type: "video",
        start_sec: start,
        end_sec: Math.min(duration, start + VIDEO_FRAME_INTERVAL_SEC),
        ...(imagePaths[index] ? { imagePath: imagePaths[index] } : {}),
      },
      language: source.language,
    });
  });

  if (!drafts.length) {
    throw new Error("No speech transcript or meaningful visual frames were extracted.");
  }
  return drafts;
}

async function embedUnits(
  unitRows: Array<{ id: string; text: string; figureCaption: string | null }>,
): Promise<void> {
  await ensureEmbeddings();
  for (let start = 0; start < unitRows.length; start += 64) {
    const batch = unitRows.slice(start, start + 64);
    const texts = batch.map((unit) =>
      [unit.text, unit.figureCaption ? `Figure: ${unit.figureCaption}` : ""]
        .filter(Boolean)
        .join("\n"),
    );
    const cacheKeys = texts.map(
      (text) => `embedding:${modelConfig.embedding}:${sha256(text)}`,
    );
    const cachedRows = await db
      .select({ cacheKey: aiCacheTable.cacheKey, response: aiCacheTable.response })
      .from(aiCacheTable)
      .where(inArray(aiCacheTable.cacheKey, cacheKeys));
    const vectorsByKey = new Map<string, number[]>(
      cachedRows.map((row) => [row.cacheKey, row.response as number[]]),
    );
    const missingIndexes = cacheKeys
      .map((key, index) => (vectorsByKey.has(key) ? -1 : index))
      .filter((index) => index >= 0);

    if (missingIndexes.length) {
      const ordered = await embedForIndex(
        missingIndexes.map((index) => texts[index]),
        "passage",
      );
      const allEntries = ordered.map((embedding, index) => ({
        cacheKey: cacheKeys[missingIndexes[index]],
        model: modelConfig.embedding,
        response: embedding,
      }));
      // Units with identical text (common in transcripts: repeated phrases, "Music", etc.) share one
      // cache key. A single INSERT ... ON CONFLICT cannot touch the same key twice
      // ("cannot affect row a second time"), so de-duplicate before writing and write in small chunks.
      const cacheEntries = [...new Map(allEntries.map((entry) => [entry.cacheKey, entry])).values()];
      for (let offset = 0; offset < cacheEntries.length; offset += 16) {
        await db
          .insert(aiCacheTable)
          .values(cacheEntries.slice(offset, offset + 16))
          .onConflictDoUpdate({
            target: aiCacheTable.cacheKey,
            set: { response: sql`excluded.response`, model: modelConfig.embedding },
          });
      }
      cacheEntries.forEach((entry) =>
        vectorsByKey.set(entry.cacheKey, entry.response as number[]),
      );
    }

    const vectors = cacheKeys.map((key) => vectorsByKey.get(key));
    if (vectors.some((vector) => !vector)) {
      throw new Error("A source unit could not be matched to its cached embedding.");
    }
    await Promise.all(
      batch.map((unit, index) =>
        db
          .update(unitsTable)
          .set({ embedding: vectors[index]! })
          .where(eq(unitsTable.id, unit.id)),
      ),
    );
  }
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 180);
}

type UnitRow = { id: string; text: string; figureCaption: string | null };

/** Asks the structure model to organise one batch of units. Throws if the model's answer is unusable. */
async function requestTaxonomy(batch: UnitRow[]): Promise<Taxonomy> {
  const promptData = batch.map((unit, index) => ({
    unitIndex: index,
    excerpt: `${unit.text}\n${unit.figureCaption ? `Visual: ${unit.figureCaption}` : ""}`.slice(0, 1100),
  }));
  const serialized = JSON.stringify(promptData);
  const cacheKey = `taxonomy:${modelConfig.structure}:${sha256(serialized)}`;
  return cachedAI<Taxonomy>(cacheKey, modelConfig.structure, async () => {
    const completion = await withRetry(() =>
      openai().chat.completions.create({
        model: modelConfig.structure,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Organize the supplied study units into a concise topic hierarchy and atomic concepts. Use only ideas supported by the excerpts, and use their language for names and descriptions where clear. Return JSON {\"topics\":[{\"name\":\"...\",\"description\":\"...\",\"concepts\":[{\"name\":\"...\",\"description\":\"...\",\"unitIndexes\":[0],\"prerequisiteNames\":[]}]}]}. Each concept must cite one or more supplied unitIndexes. Do not invent concepts or prerequisite relationships. Use at most 4 topics and 6 concepts per topic for this batch. If the excerpts contain no teachable content, return {\"topics\":[]}.",
          },
          {
            role: "user",
            content: `Create source-grounded topics and concepts for these units:\n${serialized}`,
          },
        ],
        max_completion_tokens: 1800,
      }),
    );
    const content = completion.choices[0]?.message.content;
    if (!content) throw new Error("The structure model returned an empty response.");
    const parsed = JSON.parse(content) as Partial<Taxonomy>;
    if (!Array.isArray(parsed.topics)) {
      throw new Error("The structure model returned an invalid topic hierarchy.");
    }
    return {
      topics: parsed.topics.map((topic) => ({
        name: String(topic.name ?? "").trim().slice(0, 180),
        description: String(topic.description ?? "").trim().slice(0, 1200),
        concepts: Array.isArray(topic.concepts)
          ? topic.concepts.map((concept) => ({
              name: String(concept.name ?? "").trim().slice(0, 180),
              description: String(concept.description ?? "").trim().slice(0, 1200),
              unitIndexes: Array.isArray(concept.unitIndexes)
                ? concept.unitIndexes.filter(
                    (value): value is number =>
                      Number.isInteger(value) && value >= 0 && value < batch.length,
                  )
                : [],
              prerequisiteNames: Array.isArray(concept.prerequisiteNames)
                ? concept.prerequisiteNames
                    .filter((value): value is string => typeof value === "string")
                    .map((value) => value.trim().slice(0, 180))
                : [],
            }))
          : [],
      })),
    };
  });
}

/** Writes one organised batch (topics, concepts, unit links) to the database. */
async function persistTaxonomy(
  courseId: string,
  taxonomy: Taxonomy,
  batch: UnitRow[],
  pendingEdges: Array<{ prerequisite: string; dependent: string }>,
): Promise<void> {
  for (const topic of taxonomy.topics) {
    const topicKey = normalizeName(topic.name);
    if (!topicKey) continue;
    const [existingTopic] = await db
      .select({ id: topicsTable.id })
      .from(topicsTable)
      .where(and(eq(topicsTable.courseId, courseId), eq(topicsTable.normalizedName, topicKey)))
      .limit(1);
    let topicId = existingTopic?.id;
    if (!topicId) {
      const [insertedTopic] = await db
        .insert(topicsTable)
        .values({
          courseId,
          name: topic.name || "Uncategorized",
          normalizedName: topicKey,
          description: topic.description || null,
        })
        .onConflictDoNothing()
        .returning({ id: topicsTable.id });
      topicId = insertedTopic?.id;
    }
    if (!topicId) {
      const [racedTopic] = await db
        .select({ id: topicsTable.id })
        .from(topicsTable)
        .where(and(eq(topicsTable.courseId, courseId), eq(topicsTable.normalizedName, topicKey)))
        .limit(1);
      topicId = racedTopic?.id;
    }
    if (!topicId) continue;

    for (const concept of topic.concepts) {
      const conceptKey = normalizeName(concept.name);
      if (!conceptKey) continue;
      const [existingConcept] = await db
        .select({ id: conceptsTable.id })
        .from(conceptsTable)
        .where(and(eq(conceptsTable.courseId, courseId), eq(conceptsTable.normalizedName, conceptKey)))
        .limit(1);
      let conceptId = existingConcept?.id;
      if (!conceptId) {
        const [insertedConcept] = await db
          .insert(conceptsTable)
          .values({
            courseId,
            topicId,
            name: concept.name,
            normalizedName: conceptKey,
            description: concept.description || null,
          })
          .onConflictDoNothing()
          .returning({ id: conceptsTable.id });
        conceptId = insertedConcept?.id;
      }
      if (!conceptId) {
        const [racedConcept] = await db
          .select({ id: conceptsTable.id })
          .from(conceptsTable)
          .where(and(eq(conceptsTable.courseId, courseId), eq(conceptsTable.normalizedName, conceptKey)))
          .limit(1);
        conceptId = racedConcept?.id;
      }
      if (!conceptId) continue;

      const unitIds = concept.unitIndexes
        .map((unitIndex) => batch[unitIndex]?.id)
        .filter((id): id is string => Boolean(id));
      if (unitIds.length) {
        await db
          .insert(unitConceptsTable)
          .values(unitIds.map((unitId) => ({ unitId, conceptId: conceptId! })))
          .onConflictDoNothing();
      }
      for (const prerequisite of concept.prerequisiteNames) {
        const prerequisiteKey = normalizeName(prerequisite);
        if (prerequisiteKey && prerequisiteKey !== conceptKey) {
          pendingEdges.push({ prerequisite: prerequisiteKey, dependent: conceptKey });
        }
      }
    }
  }
}

/**
 * Builds topics, concepts and prerequisites from the saved units.
 *
 * Organising is an enhancement on top of units that are already saved and searchable, so one bad
 * model answer must not fail the whole source (this used to surface as "Model returned no parseable
 * JSON" on long YouTube videos with many batches). A batch that fails is retried as two smaller
 * batches; a tiny batch that still fails is skipped. Only a real rate-limit quota exhaustion, a
 * cancellation or a database error stops the source.
 */
async function buildTaxonomy(
  courseId: string,
  unitRows: UnitRow[],
  onBatch?: (done: number, total: number) => Promise<void>,
  batchSize = 12,
): Promise<{ batches: number; failed: number }> {
  const pendingEdges: Array<{ prerequisite: string; dependent: string }> = [];
  const total = Math.ceil(unitRows.length / batchSize);
  let failed = 0;
  let lastReason = "";

  /** Returns true when at least part of the batch was organised. A failed batch is split once, never further. */
  async function organise(batch: UnitRow[], canSplit: boolean): Promise<boolean> {
    let taxonomy: Taxonomy | null = null;
    try {
      taxonomy = await requestTaxonomy(batch);
    } catch (error) {
      if (error instanceof RateLimitExhausted) throw error;
      lastReason = errorMessage(error).slice(0, 240);
    }
    if (taxonomy) {
      await persistTaxonomy(courseId, taxonomy, batch, pendingEdges);
      return true;
    }
    if (canSplit && batch.length > 4) {
      const middle = Math.ceil(batch.length / 2);
      const first = await organise(batch.slice(0, middle), false);
      const second = await organise(batch.slice(middle), false);
      return first || second;
    }
    return false;
  }

  // If the model keeps failing on every batch (wrong model, bad key, outage) stop early instead of
  // spending dozens of API calls; the units are already saved and the tutor still works.
  const GIVE_UP_AFTER = 3;
  let consecutiveFailures = 0;
  let batchesRun = 0;
  for (let start = 0; start < unitRows.length; start += batchSize) {
    if (onBatch) await onBatch(batchesRun, total);
    if (consecutiveFailures >= GIVE_UP_AFTER) {
      failed += 1;
      batchesRun += 1;
      continue;
    }
    const ok = await organise(unitRows.slice(start, start + batchSize), true);
    batchesRun += 1;
    if (ok) {
      consecutiveFailures = 0;
    } else {
      failed += 1;
      consecutiveFailures += 1;
      logger.warn({ reason: lastReason }, "A section could not be organised into topics");
      if (consecutiveFailures === GIVE_UP_AFTER) {
        logger.warn({ reason: lastReason }, "Topic building keeps failing; skipping the rest (the tutor still works)");
      }
    }
  }

  if (pendingEdges.length) {
    const courseConcepts = await db
      .select({ id: conceptsTable.id, key: conceptsTable.normalizedName })
      .from(conceptsTable)
      .where(eq(conceptsTable.courseId, courseId));
    const ids = new Map(courseConcepts.map((concept) => [concept.key, concept.id]));
    const edges = pendingEdges
      .map((edge) => ({
        courseId,
        prerequisiteConceptId: ids.get(edge.prerequisite),
        dependentConceptId: ids.get(edge.dependent),
      }))
      .filter(
        (
          edge,
        ): edge is {
          courseId: string;
          prerequisiteConceptId: string;
          dependentConceptId: string;
        } =>
          Boolean(
            edge.prerequisiteConceptId &&
              edge.dependentConceptId &&
              edge.prerequisiteConceptId !== edge.dependentConceptId,
          ),
      );
    if (edges.length) {
      await db.insert(conceptEdgesTable).values(edges).onConflictDoNothing();
    }
  }
  return { batches: total, failed };
}

async function processSource(sourceId: string): Promise<void> {
  const [source] = await db
    .select()
    .from(sourcesTable)
    .where(eq(sourcesTable.id, sourceId))
    .limit(1);
  if (!source) {
    cancelledSources.delete(sourceId);
    return;
  }
  let step = "Preparing source";
  const workDir = await mkdtemp(join(tmpdir(), "studygraph-"));
  try {
    openai();
    await ensureModels();
    await setProgress(sourceId, "processing", 3, step, null, 0);
    let captionDrafts: UnitDraft[] | null = null;
    if (source.sourceType === "video" && source.sourceUrl) {
      try {
        step = "Reading the video's captions";
        await setProgress(sourceId, "processing", 10, step);
        captionDrafts = await processYoutubeCaptions(source, workDir);
      } catch (error) {
        logger.info(
          { sourceId, reason: errorMessage(error).slice(0, 300) },
          "YouTube captions unavailable; fetching an audio-only fallback instead",
        );
      }
    }
    if (!captionDrafts && source.sourceType === "video" && source.sourceUrl) {
      step = "Fetching an audio-only YouTube fallback";
      await setProgress(sourceId, "processing", 12, step);
    }
    const inputPath = captionDrafts ? "" : await downloadSource(source, workDir);
    step = source.sourceType === "video" ? "Extracting video transcript and visuals" : "Extracting document pages";
    await setProgress(sourceId, "processing", 15, step);
    const drafts =
      captionDrafts ??
      (source.sourceType === "video"
        ? await processVideo(source, inputPath, workDir)
        : await processDocument(source, inputPath, workDir));
    if (!drafts.length) {
      throw new Error("No source-derived text, captions, or transcript segments were extracted.");
    }

    step = "Saving source-linked units";
    await setProgress(sourceId, "processing", 60, step);
    await db.delete(unitsTable).where(eq(unitsTable.sourceId, sourceId));
    const inserted = await db
      .insert(unitsTable)
      .values(
        drafts.map((draft) => ({
          sourceId,
          text: draft.text,
          figureCaption: draft.figureCaption,
          locator: draft.locator,
          language: draft.language,
        })),
      )
      .returning({
        id: unitsTable.id,
        text: unitsTable.text,
        figureCaption: unitsTable.figureCaption,
      });
    if (!inserted.length) throw new Error("No source-linked units could be saved.");

    step = "Embedding source units";
    await setProgress(sourceId, "processing", 64, step, null, inserted.length);
    await embedUnits(inserted);

    step = "Building topics, concepts, and prerequisites";
    await setProgress(sourceId, "processing", 76, step, null, inserted.length);
    const organised = await buildTaxonomy(source.courseId, inserted, (done, total) =>
      setProgress(
        sourceId,
        "processing",
        76 + (done / Math.max(1, total)) * 22,
        `${step} (${Math.min(done + 1, total)}/${total})`,
        null,
        inserted.length,
      ),
      source.sourceType === "video" ? 16 : 12,
    );

    // The units are saved and searchable at this point, so the tutor works. If some or all topic
    // batches could not be organised, say so honestly instead of failing the whole source.
    const note =
      organised.failed === 0
        ? "Source indexed and ready"
        : organised.failed >= organised.batches
          ? "Indexed for the tutor; the topic map could not be built (press Retry processing to try again)"
          : `Indexed and ready; the topic map is partial (${organised.failed} of ${organised.batches} sections could not be organised)`;
    if (organised.failed > 0) {
      logger.warn({ sourceId, ...organised }, "Source ready with an incomplete topic map");
    }
    await setProgress(sourceId, "ready", 100, note, null, inserted.length);
  } catch (error) {
    if (cancelledSources.has(sourceId)) return;
    const message = sourceError(error);
    logger.error({ sourceId, step, error: message }, "StudyGraph ingestion failed");
    await setProgress(
      sourceId,
      "failed",
      source.progress,
      `Stopped during ${step}`,
      message,
    ).catch((progressError) =>
      logger.error(
        { sourceId, error: sourceError(progressError) },
        "Could not persist ingestion failure",
      ),
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
    if (cancelledSources.delete(sourceId)) {
      await storage.deleteDerivedObjects(sourceId).catch((error) =>
        logger.warn({ sourceId, error }, "Could not remove cancelled source assets"),
      );
    }
  }
}

let running = false;
let activeSourceId: string | null = null;
const waiting = new Set<string>();
const cancelledSources = new Set<string>();

function assertNotCancelled(sourceId: string): void {
  if (cancelledSources.has(sourceId)) {
    throw new Error("Source processing was cancelled.");
  }
}

export function cancelIngestion(sourceId: string): void {
  waiting.delete(sourceId);
  if (activeSourceId === sourceId) cancelledSources.add(sourceId);
}

export function queueIngestion(sourceId: string): void {
  waiting.add(sourceId);
  void drainQueue();
}

async function drainQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (waiting.size) {
      const sourceId = waiting.values().next().value as string;
      waiting.delete(sourceId);
      activeSourceId = sourceId;
      try {
        await processSource(sourceId);
      } finally {
        activeSourceId = null;
        cancelledSources.delete(sourceId);
      }
    }
  } finally {
    running = false;
    if (waiting.size) void drainQueue();
  }
}

export async function resumeIngestionJobs(): Promise<void> {
  const interrupted = await db
    .select({ id: ingestionJobsTable.id })
    .from(ingestionJobsTable)
    .where(inArray(ingestionJobsTable.status, ["queued", "processing"]));
  for (const job of interrupted) {
    await db
      .update(ingestionJobsTable)
      .set({ status: "queued", currentStep: "Resuming after server restart" })
      .where(eq(ingestionJobsTable.id, job.id));
    await db
      .update(sourcesTable)
      .set({ status: "queued", currentStep: "Resuming after server restart" })
      .where(eq(sourcesTable.id, job.id));
    queueIngestion(job.id);
  }
}
