import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Renders one page of a PDF to PNG bytes with PyMuPDF (already a Citexa dependency, run through uv
 * exactly like the ingestion extractor). Used to rebuild a page preview when none was stored.
 */
export async function renderPdfPage(pdfPath: string, page: number, scale = 1.6): Promise<Buffer> {
  const root = resolve(process.cwd(), "../..");
  const script = resolve(process.cwd(), "src/lib/ingestion/render_page.py");
  const dir = await mkdtemp(join(tmpdir(), "citexa-page-"));
  const out = join(dir, "page.png");
  try {
    await new Promise<void>((resolveRun, rejectRun) => {
      execFile(
        "uv",
        ["run", "--project", root, "python", script, pdfPath, String(page), out, String(scale)],
        { cwd: root, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true },
        (error, _stdout, stderr) => {
          if (error) {
            const detail = String(stderr || error.message).trim().slice(-400);
            rejectRun(new Error(detail || "Could not render the page."));
          } else {
            resolveRun();
          }
        },
      );
    });
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Render the cited passage with an on-page highlight; text-match failures still return a readable page. */
export async function renderPdfPageWithHighlight(pdfPath: string, page: number, text: string): Promise<Buffer> {
  const root = resolve(process.cwd(), "../..");
  const script = resolve(process.cwd(), "src/lib/ingestion/highlight_page.py");
  const dir = await mkdtemp(join(tmpdir(), "citexa-highlight-"));
  const textPath = join(dir, "citation.txt");
  const out = join(dir, "page.png");
  try {
    await writeFile(textPath, text.slice(0, 5_000), "utf8");
    await new Promise<void>((resolveRun, rejectRun) => {
      execFile(
        "uv",
        ["run", "--project", root, "python", script, pdfPath, String(page), textPath, out],
        { cwd: root, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true },
        (error, _stdout, stderr) => {
          if (error) {
            const detail = String(stderr || error.message).trim().slice(-400);
            rejectRun(new Error(detail || "Could not highlight the cited passage."));
          } else resolveRun();
        },
      );
    });
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Rebuilds PPTX slide images through the project's extraction helper when stored previews are absent. */
export async function renderPptxSlide(pptxPath: string, slide: number): Promise<Buffer> {
  const root = resolve(process.cwd(), "../..");
  const script = resolve(process.cwd(), "src/lib/ingestion/extract.py");
  const dir = await mkdtemp(join(tmpdir(), "citexa-slide-"));
  try {
    await new Promise<void>((resolveRun, rejectRun) => {
      execFile(
        "uv",
        ["run", "--project", root, "python", script, "pptx", pptxPath, dir],
        { cwd: root, timeout: 180_000, maxBuffer: 1024 * 1024, windowsHide: true },
        (error, _stdout, stderr) => {
          if (error) {
            const detail = String(stderr || error.message).trim().slice(-500);
            rejectRun(new Error(detail || "Could not render the PowerPoint slide."));
          } else resolveRun();
        },
      );
    });
    const padded = String(slide).padStart(4, "0");
    return await readFile(join(dir, `slide-${padded}.png`));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const pptxInflight = new Map<string, Promise<Buffer>>();

export function renderPptxSlideOnce(key: string, pptxPath: string, slide: number): Promise<Buffer> {
  const existing = pptxInflight.get(key);
  if (existing) return existing;
  const run = renderPptxSlide(pptxPath, slide).finally(() => pptxInflight.delete(key));
  pptxInflight.set(key, run);
  return run;
}

const inflight = new Map<string, Promise<Buffer>>();

/** De-duplicates simultaneous renders of the same page (for example React strict-mode double requests). */
export function renderPdfPageOnce(key: string, pdfPath: string, page: number): Promise<Buffer> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const run = renderPdfPage(pdfPath, page).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

const highlightedInflight = new Map<string, Promise<Buffer>>();

export function renderPdfPageWithHighlightOnce(key: string, pdfPath: string, page: number, text: string): Promise<Buffer> {
  const existing = highlightedInflight.get(key);
  if (existing) return existing;
  const run = renderPdfPageWithHighlight(pdfPath, page, text).finally(() => highlightedInflight.delete(key));
  highlightedInflight.set(key, run);
  return run;
}
